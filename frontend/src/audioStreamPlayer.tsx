import React from 'react';

import { RtcStream } from "@bandwidth/webrtc-browser";

export interface ParticipantProps {
    rtcStream: RtcStream;
}

const AudioStreamPlayer : React.FC<ParticipantProps> = (props) => {
  const remoteStream = props.rtcStream;
  console.log("Playing audio stream: ", remoteStream);
    return (
      <video
        playsInline
        autoPlay
        style={{ display: "none" }}
        ref={(videoElement) => {
          if (
            videoElement &&
            remoteStream &&
            videoElement.srcObject !== remoteStream.mediaStream
          ) {
            // Set the video element's source object to the WebRTC MediaStream
            videoElement.srcObject = remoteStream.mediaStream;
          }
        }}
      ></video> );
}
 
export default AudioStreamPlayer;