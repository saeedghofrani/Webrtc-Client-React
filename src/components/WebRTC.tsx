import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface ChatMessage {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const WebRTC: React.FC = () => {
  const initialRoom = useMemo(() => window.location.hash.replace('#', '') || randomRoom(), []);
  const [roomId, setRoomId] = useState(initialRoom);
  const [name, setName] = useState('Saeed');
  const [status, setStatus] = useState('Ready to start a secure meeting.');
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    window.history.replaceState(null, '', `#${roomId}`);
  }, [roomId]);

  useEffect(() => {
    return () => leaveRoom();
  }, []);

  function getSocket() {
    if (!socketRef.current) {
      const endpoint = process.env.REACT_APP_SIGNALING_URL || window.location.origin;
      socketRef.current = io(endpoint, { transports: ['websocket', 'polling'] });
      bindSocket(socketRef.current);
    }
    return socketRef.current;
  }

  function bindSocket(socket: Socket) {
    socket.on('connect', () => setStatus('Connected to signaling server.'));
    socket.on('connect_error', () => setStatus('Could not connect to signaling server.'));
    socket.on('room-users', setUsers);
    socket.on('peer-ready', async () => {
      setStatus('Peer joined. Creating offer...');
      await createOffer();
    });
    socket.on('offer', async ({ offer }) => {
      const peer = await ensurePeer();
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit('answer', { roomId, answer });
      setStatus('Answered incoming call.');
    });
    socket.on('answer', async ({ answer }) => {
      if (!peerRef.current) return;
      await peerRef.current.setRemoteDescription(answer);
      setStatus('Peer connection established.');
    });
    socket.on('ice-candidate', async ({ candidate }) => {
      if (!peerRef.current || !candidate) return;
      await peerRef.current.addIceCandidate(candidate);
    });
    socket.on('chat-message', (message: ChatMessage) => {
      setMessages((current) => [...current, message]);
    });
    socket.on('peer-left', () => {
      setStatus('Peer left the room.');
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      peerRef.current?.close();
      peerRef.current = null;
    });
  }

  async function startMedia() {
    if (!window.isSecureContext) {
      setStatus('Camera and microphone require HTTPS. Open the deployed HTTPS meeting URL.');
      return null;
    }
    if (!localStreamRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    }
    return localStreamRef.current;
  }

  async function ensurePeer() {
    const stream = await startMedia();
    if (!stream) throw new Error('Media unavailable');
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection({ iceServers });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event) => {
      if (event.candidate) getSocket().emit('ice-candidate', { roomId, candidate: event.candidate });
    };
    peer.ontrack = (event) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
    };
    peer.onconnectionstatechange = () => setStatus(`Peer connection: ${peer.connectionState}`);
    peerRef.current = peer;
    return peer;
  }

  async function joinRoom() {
    try {
      await startMedia();
      const socket = getSocket();
      socket.emit('join-room', { roomId, name });
      setJoined(true);
      setStatus(`Joined room ${roomId}. Share the link to invite someone.`);
    } catch {
      setStatus('Could not access camera/microphone. Check browser permissions.');
    }
  }

  async function createOffer() {
    const peer = await ensurePeer();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    getSocket().emit('offer', { roomId, offer });
  }

  function toggleMic() {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    });
  }

  function toggleCamera() {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setCameraOn(track.enabled);
    });
  }

  function leaveRoom() {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!chatText.trim()) return;
    getSocket().emit('chat-message', { roomId, author: name, text: chatText });
    setChatText('');
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;

  return (
    <main className="meeting-shell">
      <section className="meeting-hero">
        <div>
          <p className="eyebrow">WebRTC meeting room</p>
          <h1>Secure video, voice, and chat.</h1>
          <p className="lead">Create a room, share the link, and connect peer-to-peer with Socket.IO signaling.</p>
        </div>
        <div className="room-card">
          <label>
            Your name
            <input value={name} onChange={(event) => setName(event.target.value)} disabled={joined} />
          </label>
          <label>
            Room code
            <input value={roomId} onChange={(event) => setRoomId(event.target.value.trim().toUpperCase())} disabled={joined} />
          </label>
          <div className="button-row">
            <button type="button" onClick={joinRoom} disabled={joined}>{joined ? 'Joined' : 'Start / join room'}</button>
            <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(shareUrl)}>Copy link</button>
          </div>
          <p className="status">{status}</p>
        </div>
      </section>

      <section className="meeting-grid">
        <div className="video-panel">
          <video ref={localVideoRef} autoPlay playsInline muted />
          <span>Local camera</span>
        </div>
        <div className="video-panel">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <span>Remote participant</span>
        </div>
      </section>

      <section className="control-grid">
        <div className="controls">
          <button type="button" onClick={toggleMic}>{micOn ? 'Mute mic' : 'Unmute mic'}</button>
          <button type="button" onClick={toggleCamera}>{cameraOn ? 'Hide camera' : 'Show camera'}</button>
          <button type="button" className="danger" onClick={() => window.location.reload()}>Leave room</button>
        </div>
        <div className="participants">
          <strong>Participants</strong>
          {users.length === 0 ? <span>No one joined yet.</span> : users.map((user) => <span key={user.id}>{user.name}</span>)}
        </div>
      </section>

      <section className="chat-panel">
        <div className="messages">
          {messages.length === 0 ? <p>No messages yet.</p> : messages.map((message) => (
            <article key={message.id}>
              <strong>{message.author}</strong>
              <p>{message.text}</p>
            </article>
          ))}
        </div>
        <form onSubmit={sendMessage}>
          <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Type a message..." />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
};

export default WebRTC;
