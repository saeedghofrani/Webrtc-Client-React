import React, { useRef, useEffect, useState } from 'react';
import io from 'socket.io-client';

const WebRTC: React.FC = () => {
    const [socket] = useState(() => io('http://46.249.99.178:3001/'));
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

    useEffect(() => {
        const setupMedia = async () => {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }

            const peerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });

            stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    socket.emit('ice-candidate', event.candidate);
                }
            };

            peerConnection.ontrack = event => {
                if (remoteVideoRef.current) {
                    remoteVideoRef.current.srcObject = event.streams[0];
                }
            };

            peerConnectionRef.current = peerConnection;
        };

        setupMedia();

        socket.on('offer', async (offer: RTCSessionDescriptionInit) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.setRemoteDescription(offer);
                const answer = await peerConnectionRef.current.createAnswer();
                await peerConnectionRef.current.setLocalDescription(answer);
                socket.emit('answer', answer);
            }
        });

        socket.on('answer', async (answer: RTCSessionDescriptionInit) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.setRemoteDescription(answer);
            }
        });

        socket.on('ice-candidate', async (candidate: RTCIceCandidate) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.addIceCandidate(candidate);
            }
        });

        return () => {
            socket.disconnect();
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
        };
    }, [socket]);

    const createOffer = async () => {
        if (peerConnectionRef.current) {
            const offer = await peerConnectionRef.current.createOffer();
            await peerConnectionRef.current.setLocalDescription(offer);
            socket.emit('offer', offer);
        }
    };

    return (
        <div>
            <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '300px' }} />
            <video ref={remoteVideoRef} autoPlay playsInline style={{ width: '300px' }} />
            <button onClick={createOffer}>Call</button>
        </div>
    );
};

export default WebRTC;
