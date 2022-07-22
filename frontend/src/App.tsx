import React, { useState, useEffect } from "react";
import "./App.css";
import { w3cwebsocket as W3CWebSocket } from "websocket";
import BandwidthRtc, { RtcStream } from "@bandwidth/webrtc-browser";
import AudioStreamPlayer from "./audioStreamPlayer";

const client = new W3CWebSocket("ws://127.0.0.1:8001");

const bandwidthRtc = new BandwidthRtc();

const App: React.FC = () => {
  // We will use these state variables to hold our device token and application phone number
  const [token, setToken] = useState<string>();
  const [voiceApplicationPhoneNumber, setVoiceApplicationPhoneNumber] =
    useState<string>();
  const [outboundPhoneNumber, setOutboundPhoneNumber] = useState<string>();

  // This state variable holds the remote stream objects - the audio from the phones
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RtcStream>>(new Map());
  // this state variable holds the call state for display purposes
  const [callState, setCallState] = useState<string>();
  const [rejected, setRejected] = useState<boolean>(false);
  const [audioStreamCount, setAudioStreamCount] = useState<number>(0);

  // This effect connects to our server backend to get a device token
  // It will only run the first time this component renders

  /**
   * what the websocket exchanges with the server
   * @callState is to the client, and
   * @clientEvent is to the server
   */

  interface CallState {
    event: string; // registered, callStateUpdate
    token?: string;
    tn?: string;
    callState?: string;
    message?: string;
  }

  interface clientEvent {
    event: string;
    tn?: string;
  }

  useEffect(() => {
    client.onopen = () => {
      console.log("WebSocket Client Connected");
    };
    client.onmessage = (message) => {
      const parsedMessage: CallState = JSON.parse(message.data.toString());
      console.log(`${parsedMessage.event} message received`);
      console.log("message...", parsedMessage);
      switch (parsedMessage.event) {
        case "registered": {
          setToken(parsedMessage.token);
          setVoiceApplicationPhoneNumber(parsedMessage.tn);
          setOutboundPhoneNumber("");
          setCallState("idle");
          break;
        }
        case "callStateUpdate": {
          setCallState(parsedMessage.callState);
          break;
        }
        case "error": {
          console.log(parsedMessage.message);
          alert(parsedMessage.message);
          setRejected(true)
          break;
        }
        default:
          console.log("error - server message not understood: ", parsedMessage);
      }
    };
  }, []);

  // This effect will fire when the token changes
  // It will connect a websocket to Bandwidth WebRTC, and start streaming the browser's mic
  useEffect(() => {
    if (token) {
      // Connect to Bandwidth WebRTC
      bandwidthRtc
        .connect({
          deviceToken: token,
        },
        // Uncomment to supply a custom URL
        // {
        //   websocketUrl: ''
        // }
        )
        .then(async () => {
          console.log("connected to bandwidth webrtc!");
          // Publish the browser's microphone
          await bandwidthRtc.publish({
            audio: true,
            video: false,
          });
          console.log("browser mic is streaming");
        });
    }
  }, [token]);

  // This effect sets up event SDK event handlers for remote streams
  // fires every time the page is rendered.
  useEffect(() => {
    // This event will fire any time a new stream is sent to us
    bandwidthRtc.onStreamAvailable((rtcStream: RtcStream) => {
      console.log("receiving audio!", rtcStream);
      const oldStreams : Map<string, RtcStream> = remoteStreams;
      oldStreams.set(rtcStream.endpointId, rtcStream);
      setRemoteStreams(oldStreams);
      setAudioStreamCount(remoteStreams.size);
    });

    // This event will fire any time a stream is no longer being sent to us
    bandwidthRtc.onStreamUnavailable((streamId: string) => {
      console.log("no longer receiving audio", streamId);
      const oldStreams : Map<string, RtcStream> = remoteStreams;
      if (!oldStreams.delete(streamId)) {
        console.log(`Failed to delete RTC Stream with endpoint ID ${streamId}`);
      };
      setRemoteStreams(oldStreams);
      setAudioStreamCount(remoteStreams.size);
    });
  });

  // Initiate a call to the outbound phone number listed
  const callOutboundPhoneNumber = () => {
    console.log(`calling ${outboundPhoneNumber}`);
    setCallState("outbound call");
    let data: clientEvent = {
      event: "outboundCall",
      tn: outboundPhoneNumber,
    };
    client.send(JSON.stringify(data));
    return true;
  };

  const updateTn = (element: React.ChangeEvent<HTMLInputElement>) => {
    const invalid = !element.target.value.match(/^\+1[2-9][0-9]{9}$/);
    if (!invalid) {
      setOutboundPhoneNumber(element.target.value);
    } else setOutboundPhoneNumber("");
    console.log(outboundPhoneNumber);
  };

  return (
    <div className="App">
      <header className="App-header">
      {(!rejected) ? (<React.Fragment>
        <div>WebRTC Voice Calls - using asynchronous bridge</div>
        <div>
          <span>Telephone number: {voiceApplicationPhoneNumber}</span>
        </div>
        {(remoteStreams.size > 0) ? (
          <div>
            <div>
              {[...remoteStreams.values()].map((remoteStream) => {
                console.log("displaying remote stream", remoteStream)
                return(<AudioStreamPlayer rtcStream = {remoteStream} />)
              })}
              Media Connected - {audioStreamCount} Participants
            </div>
          </div>
        ) : (
            <div>
              No calls connected
            </div>
        )}
        <div>
          <div>
              <React.Fragment>
                <span>Action:</span>
                <button
                  style={{ height: "30px", marginLeft: "10px", verticalAlign: "middle" }}
                  disabled={outboundPhoneNumber?.length === 0}
                  onClick={callOutboundPhoneNumber}
                >
                  CALL
                </button>
                <input
                  type="text"
                  name="numberToDial"
                  id="numberToDial"
                  placeholder="enter a phone number"
                  style={{ height: "30px", marginLeft: "10px", verticalAlign: "middle" }}
                  onChange={updateTn}
                />
              </React.Fragment>
          </div>
        </div>
        <div>Call State: {callState}</div>
        </React.Fragment>
        ):(
          <div><span>Sorry Charlie</span></div>
      )}
      </header>
    </div>

  );
};

export default App;
