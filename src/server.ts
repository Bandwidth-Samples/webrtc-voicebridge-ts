import path from "path";
import {isEqual} from "lodash";
import dotenv from "dotenv";
import express, { response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import {
  Bridge,
  SpeakSentence,
  Pause,
  ApiCreateCallRequest,
  ApiModifyCallRequest,
  Client as VoiceClient,
  ApiController as VoiceController,
  Response,
  State1Enum,
} from "@bandwidth/voice";
import {
  Client as WebRtcClient,
  Session,
  Participant,
  PublishPermissionEnum,
  Subscriptions,
  ApiController as WebRtcController,
  DeviceApiVersionEnum,
} from "@bandwidth/webrtc";
import WebSocket from "ws";

dotenv.config();

// TODO - confirm that the web client can leave an in-place session and another can join

const app = express();
// TODO app.use(bodyParser.json());
app.use(express.json());

const wss = new WebSocket.Server({ port: 8001 });
let clientWs: WebSocket; // for the web client signalling websocket

const port = process.env.PORT || 5000;
const accountId = <string>process.env.BW_ACCOUNT_ID;
const username = <string>process.env.BW_USERNAME;
const password = <string>process.env.BW_PASSWORD;
const voiceApplicationPhoneNumber = <string>process.env.BW_NUMBER; // the 'from' number
const voiceApplicationId = <string>process.env.BW_VOICE_APPLICATION_ID;
const voiceCallbackUrl = <string>process.env.BASE_CALLBACK_URL;

// Check to make sure required environment variables are set
if (!accountId || !username || !password) {
  console.error(
    "ERROR! Please set the BW_ACCOUNT_ID, BW_USERNAME, and BW_PASSWORD environment variables before running this app"
  );
  process.exit(1);
}

interface ParticipantInfo {
  id: string;
  token: string;
}

interface CallData {
  callType: string; 
  bridgeParticipant: ParticipantInfo;
  bridgeCallId?: string;
  phoneCallId?: string;
  phoneNumber?: string;
  phoneCallAnswered: boolean;
  webAgentNumber?: string;
}

interface CallState {
  event: string; // registered, callStateUpdate
  token?: string;
  tn?: string;
  callState?: string;
  message?: string;
}

interface ClientEvent {
  event: string; // outboundCall
  tn?: string;
}

const webRTCClient = new WebRtcClient({
  basicAuthUserName: username,
  basicAuthPassword: password,
});
const webRTCController = new WebRtcController(webRTCClient);

const voiceClient = new VoiceClient({
  basicAuthUserName: username,
  basicAuthPassword: password,
});
const voiceController = new VoiceController(voiceClient);

let sessionId: string;
let voiceCalls: Map<string, CallData> = new Map();
let webParticipant: ParticipantInfo | undefined;

process.on("SIGINT", async function () {

  voiceCalls.forEach( async ( item ,key ) => {
    const bridgeParticipant = item.bridgeParticipant;
    await killSipUriLeg(bridgeParticipant);
    await deleteParticipant(bridgeParticipant);
    // console.log("deleting bridge participant: ", key);
    voiceCalls.delete(key);
  });

  
  if (webParticipant) {
    await deleteParticipant(webParticipant);
  }
  if (sessionId) {
    await deleteSession();
  }
  process.exit();
});

/**
 * set up a websockets connection with the webclient to allow async
 * notification to be sent to that webclient.
 */
wss.on("connection", async function connection(ws, req) {
  
  if (await registerWebClient(ws)) {
    ws.on("message", async function incoming(messageBuffer) {
      const message: ClientEvent = JSON.parse(messageBuffer.toString());
      console.log("handling an incoming client event:", message);
      switch (message.event) {
        case "outboundCall":
          if (message.tn) placeACall(message.tn);
          break;
        default:
          console.log("message from client not recognized: ", message);
      }
    });
    ws.on("close", function closing(message) {
      webParticipant = undefined;
      console.log("closing the web client connection");
    });
  }

});

/**
 * The killConnection endpoint cleans up all resources, used as a callback
 * on the loss of media flow to the controlling Web Browser.
 */
app.post("/killConnection", async (req, res) => {
  res.send();

  // if the web client hangs up it kills all of the other endpoints
  // TODO - remove this restriction

  if (
    req.body.event === "onLeave" &&
    webParticipant &&
    req.body.participantId == webParticipant.id
  ) {
    console.log("deallocating all configured resources on exit");
    voiceCalls.forEach( async ( item ,key ) => {
      const bridgeParticipant = item.bridgeParticipant;
      await killSipUriLeg(bridgeParticipant);
      await deleteParticipant(bridgeParticipant);
      // console.log("deleting bridge participant: ", key);
      voiceCalls.delete(key);
    });
    await deleteParticipant(webParticipant);
    await deleteSession();
    if (clientWs) {
      clientWs.close();
    }
  }
});

/**
 * handle an incoming call that has been placed to the TN that has a
 * provisioned association with this application
 * (long story - see setup in the README)
 */
app.post("/incomingCall", async (req, res) => {
  console.log(`incoming call received from ${req.body.from}`);
  updateCallStatus("inbound call");

  // setup the interconnection to webRTC
  const bridgeParticipant = await createParticipant("SIP Bridge connector");
  // start the Asynchronous creation of the interconnection between Programmable Voice and
  // WebRTC while we embark on completing the Programmable Voice handling
  // of the incomming call.

  const data: CallData = createNewCallData( bridgeParticipant, "incoming" );
  data.phoneCallId = req.body.callId;
  data.phoneNumber = req.body.from;
  // console.log ("*** CallData in incoming call:", data);
  callSipUri(bridgeParticipant, data);

  // the bridgeCallAnswered will complete the interconnection once the second leg is set up.
  // we know that this is the initial creation of the CallData because incoming call is an initial event

  const speakSentence = new SpeakSentence({
    sentence: "We're finding the other party",
  });

  const pause = new Pause({
    duration: 120,
  });

  const response = new Response();
  response.add(speakSentence);
  response.add(pause); // should be unnecessary, and replaced by the bridge when applied.
  const myResp: string = await response.toBxml();

  res.send(myResp);
  console.log(`Bridging inbound call: ${req.body.callId}`);
});

/**
 * /callStatus handles all telephone call status events:
 *  - primarily disconnects by the phone
 */
app.post("/callStatus", async (req, res) => {
  res.status(200).send();

  try {
    // attempt to clean up the call to webrtc on all apparent disconnects from the phone
    // or the webrtc sides.  If the resource is not present, then there is nothing to clean up.
    // the leg is tied to the telephone number of the voice endpoint
    if (req.body.eventType === "disconnect") {
      const callId = req.body.callId;
      console.log(`Handling disconnect event for call ${callId}`);

      const data: CallData | undefined = findCallFromWhatWeHave ({phoneCallId: callId});
      const bridgeParticipant : ParticipantInfo | undefined = data?.bridgeParticipant;

      if (bridgeParticipant) {
        await killSipUriLeg(bridgeParticipant);
        await deleteParticipant(bridgeParticipant);
        // console.log("deleting bridge participant: ", bridgeParticipant.id);
        voiceCalls.delete(bridgeParticipant.id);
      };

    } else {
      console.log("received unexpected status update", req.body);
    }
  } catch (e) {
    console.log(`failed to cleanup departing participants...${e}`);
  }
});

/**
 * Bandwidth's Voice API will hit this endpoint when an outgoing call is answered
 * the outbound call will be connected to the bridge
 */
app.post("/callAnswered", async (req, res) => {
  const callId = req.body.callId;
  console.log(
    `received answered callback for outbound call ${callId} to ${req.body.to}`
  );

  // there should be a voiceCalls record that has been created for the bridge.
  // find that record and 

  // This is the response payload that we will send back to the Voice API
  // to bridge the call into the WebRTC session
  const response = new Response();
  const speakSentence = new SpeakSentence({
    sentence: "The call will start now",
  });
  response.add(speakSentence);

  const data: CallData | undefined = findCallFromWhatWeHave({phoneCallId:callId});
  if (data) data.phoneCallAnswered = true;

  const bridgecallId: string | undefined = data?.bridgeCallId;
  if (bridgecallId  && data?.phoneCallAnswered) {
    // the sipinterconnect call exists - bridge them
    const bridge = new Bridge({
      callId: bridgecallId,
      bridgeTargetCompleteUrl: `${voiceCallbackUrl}/endBridgeLeg`,
    });

    response.add(bridge);
    console.log(`Bridging outbound call - ${callId}`);
  } else {
    const pause = new Pause({
      duration: 120,
    });
    response.add(pause);
    console.log(`Pausing to await the other call leg before bridging - ${callId}`);
  }

  let myResp: string = await response.toBxml();
  
  // console.log("BXML for the answered call: ", myResp);

  res.send(myResp);
});

/**
 * the /bridgeCallAnswered api call completes the linkage of the webRTC and
 * V2 Voice environments
 */
app.post("/bridgeCallAnswered", async (req, res) => {
  const bridgeCallId = req.body.callId;
  console.log(
    `Received answered callback from WebRTC ${bridgeCallId}`
  );

  const response = new Response();
  const speakSentence = new SpeakSentence({
    sentence: `a call is happening`,
  });

  // TODO - this is a replica of the /callanswered logic - condense into a function
  
  // if there is another call present, bridge it in, otherwise wait for another call.
  const callData: CallData|undefined =findCallFromWhatWeHave({bridgeCallId:bridgeCallId})  // look for any calls that are hanging around.
  console.log("data in bridgeCallAnswered:", callData);
  if (callData && callData.phoneCallId && callData.phoneCallAnswered) {
    // there is an existing voice call that should be bridged
    console.log(
      "Bridge the preexisting voice call: ",
      callData.phoneCallId,
      // callData
    );
    // the SIP call to the WebRTC side exists - bridge the two calls
    const bridge = new Bridge({
      callId: callData.phoneCallId,
      // flip the 'endedness of the callback on hangup
      bridgeCompleteUrl: `${voiceCallbackUrl}/endBridgeLeg`,
    });
    response.add(bridge);
    console.log("Bridging the calls in bridgeCallAnswered");
  } else {
    const pause = new Pause({
      duration: 120,
    });
    response.add(pause);
    console.log("Pausing to wait for the other party in bridgeCallAnswered");
  }

  let myResp = await response.toBxml();
  res.send(myResp);
  updateCallStatus("connected");
});

/**
 * /endBridgeLeg is used to clean up when the phone hangs up, which takes down the bridge
 * this is triggered by registering a callback when the two calls are bridged.
 */
app.post("/endBridgeLeg", async (req, res) => {
  try {
    if (
      req.body.eventType === "bridgeTargetComplete" ||
      req.body.eventType === "bridgeComplete"
    ) {
      // the cleanup should already have been done
      const callId = req.body.callId;
      console.log(`Received endBridgeLeg event for call ${callId}`);


      const data: CallData | undefined = findCallFromWhatWeHave ({bridgeCallId: callId});

      // remove the SIP interconnect
      if (!data?.bridgeParticipant.id) {
        console.log( "Can't find the bridge participant for ", callId);
      } else {
        await killSipUriLeg(data?.bridgeParticipant);
        await deleteParticipant(data?.bridgeParticipant);
      }

      const pause = new Pause({
        duration: 10,
      });

      const response = new Response();
      // response.add(speakSentence);
      response.add(pause);

      let myResp = await response.toBxml();
      res.send(myResp);
      updateCallStatus("idle");
    } else {
      console.log("received unexpected bridge status update", req.body);
      res.status(200).send();
    }
  } catch (e) {
    console.log(`failed to cleanup departing participants...${e}`);
    res.status(200).send();
  }
});

app.post("/*", (req, res) => {
  // clean up any API calls
  console.log("something unexpected received", req.url, req.baseUrl, req.body);
  res.status(200).send();
});

// These two lines set up static file serving for the React frontend
app.use(express.static(path.join(__dirname, "..", "frontend", "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "build", "index.html"));
});
app.listen(port, () =>
  console.log(`WebRTC Hello World listening on port ${port}!`)
);

/**
 * Create a new participant and save their ID to our app's state map
 */
const createParticipant = async (tag: string): Promise<ParticipantInfo> => {
  const participantBody: Participant = {
    tag: tag,
    publishPermissions: [PublishPermissionEnum.AUDIO],
    deviceApiVersion: DeviceApiVersionEnum.V3,
  };

  let createParticipantResponse = await webRTCController.createParticipant(
    accountId,
    participantBody
  );
  const participant = createParticipantResponse.result.participant;

  if (!participant?.id) {
    throw Error("the participant was not returned");
  }
  const participantId = participant?.id;
  if (!createParticipantResponse.result.token) {
    throw Error("the token was not returned");
  }
  const token = createParticipantResponse.result.token;

  console.log(`created new participant ${participantId}`);

  // Add participant to session
  const sessionId = await getSessionId();
  const subscriptions: Subscriptions = {
    sessionId: sessionId,
  };

  await webRTCController.addParticipantToSession(
    accountId,
    sessionId,
    participantId,
    subscriptions
  );

  return {
    id: participantId,
    token: token,
  };
};

/**
 * Get a new or existing WebRTC session ID
 */
const getSessionId = async (): Promise<string> => {
  // If we already have a valid session going, just re-use that one
  if (sessionId) {
    try {
      let getSessionResponse = await webRTCController.getSession(
        accountId,
        sessionId
      );
      const existingSession: Session = getSessionResponse.result;
      console.log(`using session ${sessionId}`);
      if (existingSession.id === sessionId) {
        return sessionId;
      } else
        throw Error(
          `saved session IDs don't match ${existingSession.id}, ${sessionId}`
        );
    } catch (e) {
      console.log(`session ${sessionId} is invalid, creating a new session`);
    }
  }

  // Otherwise start a new one and return the ID
  const createSessionBody: Session = {
    tag: "v2-voice-conference-model",
  };
  let response = await webRTCController.createSession(
    accountId,
    createSessionBody
  );
  if (!response.result.id) {
    throw Error("No Session ID in Create Session Response");
  }
  sessionId = response.result.id;
  console.log(`created new session ${sessionId}`);
  return sessionId;
};

/**
 * Delete a session
 */
const deleteSession = async () => {
  if (sessionId) {
    try {
      await webRTCController.deleteSession(accountId, sessionId);
      console.log(`Deleted WebRTC session: ${sessionId} `);
      sessionId = "";
    } catch (e) {
      console.log("failed to delete session", sessionId);
      const err:any = e;
      console.log("error", err.response.status, err.response.data, err.config.url);
    }
  }
};

/**
 * Delete a participant
 */
const deleteParticipant = async (participant: ParticipantInfo) => {
  try {
    if (participant.id) {
      await webRTCController.deleteParticipant(accountId, participant.id);
    }
    console.log(`Deleted Participant ${participant.id}`);
  } catch (e) {
    const err:any = e;
    if (err.statusCode === 404) {
      // participants can get deleted when the media server detects loss of session / media flows
      console.log("participant already deleted", participant.id);
    } else {
      console.log("failure to delete participant", participant?.id);
      console.log("error", err.request, err.headers, err.statusCode, err.body);
    }
  }
};

/**
 * Use Bandwidth's Voice API to call the outbound phone number,
 * with an answer callback that will conference the outbound call on the V2 voice
 * side of the infrastructure
 */
const callPhone = async (phoneNumber: string)  => {
  const createCallRequest: ApiCreateCallRequest = {
    from: voiceApplicationPhoneNumber,
    to: phoneNumber,
    answerUrl: `${voiceCallbackUrl}/callAnswered`,
    disconnectUrl: `${voiceCallbackUrl}/callStatus`,
    applicationId: voiceApplicationId,
  };
  try {
    let response = await voiceController.createCall(
      accountId,
      createCallRequest
    );
    const callId = response.result.callId;
    console.log(`initiated call ${callId} to ${phoneNumber}...`);
    updateCallStatus("outbound call");
    return callId;
  } catch (e) {
    console.log(`error calling ${phoneNumber}: ${e}`);
  }
};

/**
 * Ask Bandwidth's Voice API to call the webRTC infrastructure with the
 * participant token in the UUI SIP header to allow the correlation of
 * V2 voice and the webRTC infrastructure
 */
// TODO - upgrade from axios when the SDK supports UUI
const callSipUri = async (participant: ParticipantInfo, data: CallData) => {

  try {
    const body = {
      from: voiceApplicationPhoneNumber,
      to: "sip:sipx.webrtc.bandwidth.com:5060",
      answerUrl: `${voiceCallbackUrl}/bridgeCallAnswered`,
      disconnectUrl: `${voiceCallbackUrl}/callStatus`,
      applicationId: voiceApplicationId,
      uui: `${participant.token};encoding=jwt`,
    };

    let response = await axios.post(
      `https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls`,
      body,
      {
        auth: {
          username: username,
          password: password,
        },
      }
    );
    const callId = response.data.callId;
    console.log(
      `Placing a SIP call to WebRTC using ${callId}`
    );
    data.bridgeCallId = callId;

  } catch (e) {
    console.log(`error calling sip:sipx.webrtc.bandwidth.com:5060: ${e}`);
  }
  // console.log("*** bridge record", data);
  return data;
};

/**
 * remove the SIP URI leg from between the V2 Voice infrastructure and the
 * WebRTC infrastructure
 */
const killSipUriLeg = async (participant: Participant) => {
  try {

    let  callData : CallData | undefined;
    if (participant?.id) callData = voiceCalls.get(participant.id);

    if (!participant) {
      console.log(
        "participant not found for sipx bridge - it must have been removed already"
      ) 
    } else if (!callData?.bridgeCallId) {
      console.log(
        "callId not found for sipx bridge - it must have been removed already"
      );
    } else {
      const callId = callData?.bridgeCallId;
      console.log(
        `Attempting to remove WebRTC SIP Call Leg - callId: ${callId} participant: ${participant.id}`
      );

      const modifyCallRequest: ApiModifyCallRequest = {
        state: State1Enum.Completed,
        redirectUrl: "",
      };
      try {
        let response = await voiceController.modifyCall(
          accountId,
          callId,
          modifyCallRequest
        );
        console.log(`ending call ${callId}`);
      } catch (e) {
        console.log(`error in ending call ${callId}: ${e}`);
      }
      if (!voiceCalls.delete(callId)) {
        console.log(
          `failed to remove sipx bridge leg ${callId} - it was likely previously deleted`
        );
      } else {
        console.log(`Deleted conference sipx leg`);
      }
    }
  } catch (e) {
    console.log(`failed to kill the sip:sipx.webrtc.bandwidth.com:5060 leg.`);
    console.log(e);
  }
};

/**
 * Initialize the relationship with the web client
 * @param ws the Websocket for communicating with the web client.
 */
const registerWebClient = async (ws: WebSocket) : Promise<boolean> => {

  if (!webParticipant) {
    clientWs = ws; // formally remember the web socket for later use
    webParticipant = await createParticipant("voice-bridge-browser");
    const message: CallState = {
      event: "registered",
      token: webParticipant.token,
      tn: voiceApplicationPhoneNumber,
      callState: "idle",
    };
    console.log("Websocket connection established with web client");
    ws.send(JSON.stringify(message));
    return true;
  } else {
    const message: CallState = {
      event: "error",
      message: "Only one browser agent is allowed"
    };
    console.log("Second Websocket connection attempted and failed");
    ws.send(JSON.stringify(message));
    return false;
  }

};

/**
 * place a call to an outbound TN as requested by the webClient
 * @param tn - the destination phone
 * @returns
 */
const placeACall = async (tn: string) => {
  console.log("calling a phone", tn);
  const outboundPhoneNumber = tn;
  if (
    !outboundPhoneNumber ||
    !outboundPhoneNumber.match(/^\+1[2-9][0-9]{9}$/)
  ) {
    console.log("missing or incorrectly formatted telephone number");
    return;
  }
  // note that this will initiate the call in parallel with linking V2 voice to WebRTC.
  // it is assumed that the bridge will succeed before the user answers and the
  //     answer is processed - the completion of the sip bridge could be
  //     waited on, but that will simply be treated as an error at this time.
  const bridgeParticipant = await createParticipant("SIP Bridge connector");
  const data: CallData = createNewCallData( bridgeParticipant, "outgoing", false );
  data.phoneNumber = outboundPhoneNumber;
  data.phoneCallId = await callPhone(outboundPhoneNumber);
  console.log("***data in placecall", data);
  callSipUri(bridgeParticipant, data); 
};

const findCallFromWhatWeHave = (filterElements:any) :CallData | undefined => {
  // console.log("*** findCallFromWhatWeHave:", filterElements);

  let data:  CallData | undefined;

  for (let [voiceCallKey, voiceCallValue] of voiceCalls.entries()) {
    const newVersion = {...voiceCallValue, ...filterElements};
    // console.log("***compare:", voiceCallValue, newVersion);
    const result = isEqual( voiceCallValue, newVersion);
    // console.log("***compare: ", result);
    if (result) { data = voiceCallValue; }
}

  // console.log("*** findCallFromWhatWeHave returns", data);
  return data;
};

const updateCallStatus = (state: string) => {
  const message: CallState = {
    event: "callStateUpdate",
    callState: state,
  };
  console.log("Updating the call state in the client", message);
  clientWs.send(JSON.stringify(message));
};

const createNewCallData = (bridgeParticipant:ParticipantInfo, callType: string, answered:boolean = true) : CallData => {
   
  const data: CallData = {
    bridgeParticipant: bridgeParticipant,
    webAgentNumber: voiceApplicationPhoneNumber,
    callType: callType,
    phoneCallAnswered: answered
  };

  voiceCalls.set( bridgeParticipant.id, data) ;

  return data;
}
