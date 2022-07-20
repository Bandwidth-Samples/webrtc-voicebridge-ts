import React from "react";
import { RtcStream } from "@bandwidth/webrtc-browser";

export interface ParticipantProps {
    rtcStream: RtcStream;
}

const Participant: React.FC<ParticipantProps> = (props) => {
    return (
        <div>
            <div className="row border">
                <div>
                    <label>Stream: {props.rtcStream.mediaStream.id}</label>
                </div>
                <div>
                    <label>Video Element:</label>
                    <video
                        playsInline
                        autoPlay
                        style={{ display: "none" }}
                        key={props.rtcStream.endpointId}
                        ref={(videoElement) => {
                            if (
                                videoElement &&
                                props.rtcStream.mediaStream &&
                                videoElement.srcObject !== props.rtcStream.mediaStream
                            ) {
                                // Set the video element's source object to the WebRTC MediaStream
                                videoElement.srcObject = props.rtcStream.mediaStream;
                            }
                        }}
                    ></video>
                </div>
                <div>
                    <label>Media path - media connected...</label>
                </div>
            </div>
        </div>
    );
};

export default Participant;
