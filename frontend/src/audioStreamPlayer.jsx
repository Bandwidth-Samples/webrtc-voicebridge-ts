import React, { useState, useEffect } from 'react';


const AudioStreamPlayer = ({endpointId:string, mediaStream:any}) => {
    return (               <video
        playsInline
        autoPlay
        style={{ display: "none" }}
        ref={(videoElement) => {
          if (
            videoElement &&
            remoteStream &&
            videoElement.srcObject !== mediaStream
          ) {
            // Set the video element's source object to the WebRTC MediaStream
            videoElement.srcObject = mediaStream;
          }
        }}
      ></video> );
}
 
export default AudioStreamPlayer;