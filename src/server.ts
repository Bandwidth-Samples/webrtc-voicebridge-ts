import path from "path";
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

const app = express();
app.use(bodyParser.json());

const wss = new WebSocket.Server({ port: 8001 });
let clientWs: WebSocket; // for the client signalling websocket

const port = process.env.PORT || 5000;
const accountId = <string>process.env.BW_ACCOUNT_ID;
const username = <string>process.env.BW_USERNAME;
const password = <string>process.env.BW_PASSWORD;
const voiceApplicationPhoneNumber = <string>process.env.BW_NUMBER; // the 'from' number
const voiceApplicationId = <string>process.env.BW_VOICE_APPLICATION_ID;
const voiceCallbackUrl = <string>process.env.BASE_CALLBACK_URL;

// console.log(
//   "call control url is...",
//   process.env.BANDWIDTH_WEBRTC_CALL_CONTROL_URL
// );
const callControlUrl = `${process.env.BANDWIDTH_WEBRTC_CALL_CONTROL_URL}/accounts/${accountId}`;

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
  from: string;
  to: string;
  callType: string;
}

interface callState {
  event: string; // registered, callStateUpdate
  token?: string;
  tn?: string;
  callState?: string;
}

interface clientEvent {
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
let bridgeParticipant: ParticipantInfo;
let webParticipant: ParticipantInfo;

process.on("SIGINT", async function () {
  if (bridgeParticipant) {
    await killSipUriLeg(bridgeParticipant);
    await deleteParticipant(bridgeParticipant);
  }
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
  registerWebClient(ws);

  ws.on("message", async function incoming(messageBuffer) {
    const message: clientEvent = JSON.parse(messageBuffer.toString());
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
    console.log("closing the web client connection");
  });
});

/**
 * The killConnection endpoint cleans up all resources, used as a callback
 * on the loss of media flow to the controlling Web Browser.
 */
app.post("/killConnection", async (req, res) => {
  res.send();

  if (
    req.body.event === "onLeave" &&
    webParticipant &&
    req.body.participantId == webParticipant.id
  ) {
    console.log("deallocating all configured resources on exit");
    await killSipUriLeg(bridgeParticipant);
    await deleteParticipant(bridgeParticipant);
    await deleteParticipant(webParticipant);
    await deleteSession();
    clientWs.close();
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
  bridgeParticipant = await createParticipant("hello-world-phone");
  // TODO - confirm the async behavior on call setup
  callSipUri(bridgeParticipant);

  // the bridgeCallAnswered will complete the interconnection once the second leg is set up.

  const callId = req.body.callId;
  const data: CallData = {
    from: req.body.from,
    to: req.body.to,
    callType: "inbound",
  };

  voiceCalls.set(callId, data); // preserve the info on the inbound call leg in the calls map.

  const speakSentence = new SpeakSentence({
    sentence: "We're finding the other party",
  });

  var pause = new Pause({
    duration: 120,
  });

  const response = new Response();
  response.add(speakSentence);
  response.add(pause); // should be unnecessary, and replaced by the bridge when applied.
  const myResp: string = await response.toBxml();
  // Send the payload back to the Voice API
  res.send(myResp);
  console.log(`Bridging inbound call using Programmable Voice - ${callId}`);
});

/**
 * /callStatus handles all telephone call status events:
 *  - primarily disconnects by the phone
 */
app.post("/callStatus", async (req, res) => {
  res.status(200).send();

  try {
    if (req.body.eventType === "disconnect") {
      const callId = req.body.callId;
      console.log(`received disconnect event for call ${callId}`);

      const callData = voiceCalls.get(callId);
      if (callData?.callType === "bridge") {
        // results from disconnecting the bridge - clean up
        deleteParticipant(bridgeParticipant);
      }
      voiceCalls.delete(callId);
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

  // preserve the call-leg
  let data: CallData = {
    from: req.body.from,
    to: req.body.to,
    callType: "outbound",
  };

  voiceCalls.set(callId, data); // preserve the info on the bridge leg in the calls map.

  // This is the response payload that we will send back to the Voice API to conference the call into the WebRTC session
  var response = new Response();
  var speakSentence = new SpeakSentence({
    sentence: "The call will start now",
  });
  response.add(speakSentence);

  const bridgecallId: string = findCall("bridge");
  if (bridgecallId) {
    // the sipinterconnect call exists - bridge them
    var bridge = new Bridge({
      callId: bridgecallId,
      bridgeTargetCompleteUrl: `${voiceCallbackUrl}/endBridgeLeg`,
    });

    response.add(bridge);
  } else {
    const pause = new Pause({
      duration: 120,
    });
    response.add(pause);
  }

  let myResp: string = await response.toBxml();
  console.log(`Bridging outbound call using Programmable Voice - ${callId}`);
  console.log("BXML for the answered call: ", myResp);

  // Send the payload back to the Voice API
  res.send(myResp);
});

/**
 * the /bridgeCallAnswered api call completes the linkage of the webRTC and
 * V2 Voice environments
 */
app.post("/bridgeCallAnswered", async (req, res) => {
  const bridgeCallId = req.body.callId;
  console.log(
    `received answered callback SIP to WebRTC Bridge ${bridgeCallId} to ${req.body.to}`
  );

  // preserve the call-leg
  let data: CallData = {
    from: req.body.from,
    to: req.body.to,
    callType: "bridge",
  };

  voiceCalls.set(bridgeCallId, data); // preserve the info on the bridge leg in the calls map.

  var response = new Response();
  var speakSentence = new SpeakSentence({
    sentence: `a call is happening`,
  });

  // if there is another call present, around bridge it in, otherwise wait for another call.
  let otherCallId = findCall("outbound") || findCall("inbound"); // look for any calls that are hanging around.
  if (otherCallId) {
    // there is an existing voice call that should be bridged
    console.log(
      "bridge the preexisting voice call: ",
      otherCallId,
      voiceCalls.get(otherCallId)
    );
    // the sipinterconnect call exists - bridge them
    var bridge = new Bridge({
      callId: otherCallId,
      // flip the 'endedness of the callback on hangup
      bridgeCompleteUrl: `${voiceCallbackUrl}/endBridgeLeg`,
    });
    response.add(bridge);
  } else {
    const pause = new Pause({
      duration: 120,
    });
    response.add(pause);
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
      console.log(`received endBridgeLeg event for call ${callId}`);

      // remove the SIP interconnect
      await killSipUriLeg(bridgeParticipant);
      await deleteParticipant(bridgeParticipant);

      // var speakSentence = new SpeakSentence({
      //   sentence: "placing another call",
      // });
      var pause = new Pause({
        duration: 10,
      });

      var response = new Response();
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
  // clean up any spurious messages
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
    callbackUrl: `${voiceCallbackUrl}/killConnection`,
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
      console.log("error", e.response.status, e.response.data, e.config.url);
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
    if (e.statusCode === 404) {
      // participants can get deleted when the media server detects loss of session / media flows
      console.log("participant already deleted", participant.id);
    } else {
      console.log("failure to delete participant", participant?.id);
      console.log("error", e.request, e.headers, e.statusCode, e.body);
    }
  }
};

/**
 * Use Bandwidth's Voice API to call the outbound phone number,
 * with an answer callback that will conference the outbound call on the V2 voice
 * side of the infrastructure
 */
const callPhone = async (phoneNumber: string) => {
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
const callSipUri = async (participant: ParticipantInfo) => {
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
      `establishing a Voice call between Programmable Voice and WebRTC using ${callId}`
    );
    return response;
  } catch (e) {
    console.log(`error calling sip:sipx.webrtc.bandwidth.com:5060: ${e}`);
  }
};

/**
 * remove the SIP URI leg from between the V2 Voice infrastructure and the
 * WebRTC infrastructure
 */
const killSipUriLeg = async (participant: Participant) => {
  try {
    // kill the call and the conference should come down when empty
    // find the callId

    const callId = findCall("bridge");

    if (!callId) {
      console.log(
        "callId not found for sipx bridge - it must have been removed already"
      );
    } else if (!participant) {
      console.log(
        "participant not found for sipx bridge - it must have been removed already"
      );
    } else {
      console.log(
        `Removing the bridging SIP Call Leg - callId: ${callId} participant: ${participant.id}`
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
const registerWebClient = async (ws: WebSocket) => {
  clientWs = ws; // formally remember the web socket for later use
  webParticipant = await createParticipant("hello-world-browser");
  const message: callState = {
    event: "registered",
    token: webParticipant.token,
    tn: voiceApplicationPhoneNumber,
    callState: "idle",
  };
  console.log("Websocket connection established with web client");
  ws.send(JSON.stringify(message));
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
  bridgeParticipant = await createParticipant("hello-world-phone");
  callSipUri(bridgeParticipant); // fire and forget
  callPhone(outboundPhoneNumber); // fire and forget
};

const findCall = (callType: string) => {
  let callId: string = "";
  for (let [key, value] of voiceCalls.entries()) {
    if (value.callType === callType) {
      callId = key;
    }
  }
  return callId;
};

const updateCallStatus = (state: string) => {
  const message: callState = {
    event: "callStateUpdate",
    callState: state,
  };
  console.log("updating the call state", message);
  clientWs.send(JSON.stringify(message));
};
