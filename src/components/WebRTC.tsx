import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface ChatMessage {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

interface RoomUser {
  id: string;
  name: string;
}

type SidePanel = 'chat' | 'people';

const iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const turnUrls = process.env.REACT_APP_TURN_URLS?.split(',').map((url) => url.trim()).filter(Boolean);
if (turnUrls?.length) {
  iceServers.push({
    urls: turnUrls,
    username: process.env.REACT_APP_TURN_USERNAME,
    credential: process.env.REACT_APP_TURN_CREDENTIAL,
  });
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeRoom(value: string) {
  return value.replace(/[^a-z0-9-]/gi, '').slice(0, 24).toUpperCase();
}

const WebRTC: React.FC = () => {
  const initialRoom = useMemo(() => normalizeRoom(window.location.hash.replace('#', '')) || randomRoom(), []);
  const [roomId, setRoomId] = useState(initialRoom);
  const [name, setName] = useState('Saeed');
  const [status, setStatus] = useState('Ready to join');
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [sidePanel, setSidePanel] = useState<SidePanel>('chat');
  const [copyLabel, setCopyLabel] = useState('Copy link');
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomIdRef = useRef(roomId);
  const remotePeerIdRef = useRef<string | null>(null);
  const queuedCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    roomIdRef.current = roomId;
    window.history.replaceState(null, '', `#${roomId}`);
  }, [roomId]);

  useEffect(() => {
    return () => leaveRoom(false);
  }, []);

  function addDiagnostic(message: string) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setDiagnostics((current) => [`${time} ${message}`, ...current].slice(0, 8));
  }

  function getSocket() {
    if (!socketRef.current) {
      const endpoint = process.env.REACT_APP_SIGNALING_URL || window.location.origin;
      socketRef.current = io(endpoint, { transports: ['websocket', 'polling'] });
      bindSocket(socketRef.current);
    }
    return socketRef.current;
  }

  function bindSocket(socket: Socket) {
    socket.on('connect', () => {
      addDiagnostic(`Signaling connected: ${socket.id}`);
      setStatus(joined ? 'Connected to signaling' : 'Ready to join');
    });
    socket.on('connect_error', (error) => {
      addDiagnostic(`Signaling failed: ${error.message}`);
      setStatus('Could not connect to signaling server');
    });
    socket.on('room-users', (roomUsers: RoomUser[]) => {
      addDiagnostic(`Room has ${roomUsers.length} participant${roomUsers.length === 1 ? '' : 's'}`);
      setUsers(roomUsers);
    });
    socket.on('peer-ready', async ({ peerId, name: peerName }: { peerId: string; name: string }) => {
      remotePeerIdRef.current = peerId;
      addDiagnostic(`Peer ready: ${peerName || peerId}`);
      setStatus(`${peerName || 'Peer'} joined. Connecting...`);
      await createOffer(peerId);
    });
    socket.on('offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      remotePeerIdRef.current = from;
      addDiagnostic('Received offer');
      const peer = await ensurePeer();
      await peer.setRemoteDescription(offer);
      await flushQueuedCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit('answer', { roomId: roomIdRef.current, to: from, answer });
      setStatus('Answer sent. Establishing media...');
    });
    socket.on('answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      remotePeerIdRef.current = from;
      if (!peerRef.current) return;
      addDiagnostic('Received answer');
      await peerRef.current.setRemoteDescription(answer);
      await flushQueuedCandidates();
      setStatus('Media negotiation complete');
    });
    socket.on('ice-candidate', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      remotePeerIdRef.current = from;
      if (!candidate) return;
      if (!peerRef.current?.remoteDescription) {
        queuedCandidatesRef.current.push(candidate);
        return;
      }
      addDiagnostic('Received ICE candidate');
      await peerRef.current.addIceCandidate(candidate);
    });
    socket.on('chat-message', (message: ChatMessage) => {
      setMessages((current) => [...current, message]);
    });
    socket.on('peer-left', ({ peerId }: { peerId: string }) => {
      if (remotePeerIdRef.current && remotePeerIdRef.current !== peerId) return;
      remotePeerIdRef.current = null;
      setRemoteConnected(false);
      addDiagnostic('Peer left');
      setStatus('The other participant left');
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      peerRef.current?.close();
      peerRef.current = null;
    });
  }

  async function startMedia() {
    if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      setStatus('Camera and microphone require HTTPS. Use the deployed HTTPS meeting URL.');
      return null;
    }
    if (!localStreamRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setMicOn(stream.getAudioTracks().some((track) => track.enabled));
      setCameraOn(stream.getVideoTracks().some((track) => track.enabled));
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    return localStreamRef.current;
  }

  async function ensurePeer() {
    const stream = await startMedia();
    if (!stream) throw new Error('Media unavailable');
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection({ iceServers });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      addDiagnostic(`Sending ICE candidate: ${event.candidate.type || 'candidate'}`);
      getSocket().emit('ice-candidate', {
        roomId: roomIdRef.current,
        to: remotePeerIdRef.current,
        candidate: event.candidate,
      });
    };
    peer.onicecandidateerror = (event) => {
      const iceError = event as RTCPeerConnectionIceErrorEvent;
      addDiagnostic(`ICE candidate error: ${iceError.errorText || iceError.errorCode}`);
    };
    peer.oniceconnectionstatechange = () => {
      addDiagnostic(`ICE state: ${peer.iceConnectionState}`);
      if (peer.iceConnectionState === 'failed') {
        setStatus('ICE failed. This network may require a TURN relay.');
      }
    };
    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
      addDiagnostic(`Remote ${event.track.kind} track received`);
      setRemoteConnected(true);
      setStatus('Connected');
    };
    peer.onconnectionstatechange = () => {
      addDiagnostic(`Peer state: ${peer.connectionState}`);
      if (peer.connectionState === 'connected') {
        setRemoteConnected(true);
        setStatus('Connected');
      }
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        setRemoteConnected(false);
        setStatus(`Peer connection ${peer.connectionState}`);
      }
    };
    peerRef.current = peer;
    return peer;
  }

  async function flushQueuedCandidates() {
    if (!peerRef.current?.remoteDescription) return;
    const queued = queuedCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      await peerRef.current.addIceCandidate(candidate);
    }
  }

  async function joinRoom() {
    try {
      const cleanRoom = normalizeRoom(roomId) || randomRoom();
      setRoomId(cleanRoom);
      roomIdRef.current = cleanRoom;
      setStatus('Starting camera and microphone...');
      await ensurePeer();
      getSocket().emit('join-room', { roomId: cleanRoom, name: name.trim() || 'Guest' });
      setJoined(true);
      setStatus(`Joined ${cleanRoom}. Waiting for another participant.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not access camera/microphone');
    }
  }

  async function createOffer(peerId: string) {
    const peer = await ensurePeer();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    addDiagnostic('Sending offer');
    getSocket().emit('offer', { roomId: roomIdRef.current, to: peerId, offer });
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

  function leaveRoom(reload = true) {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (reload) window.location.reload();
  }

  async function copyLink() {
    await navigator.clipboard?.writeText(shareUrl);
    setCopyLabel('Copied');
    window.setTimeout(() => setCopyLabel('Copy link'), 1400);
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!chatText.trim()) return;
    getSocket().emit('chat-message', { roomId: roomIdRef.current, author: name, text: chatText });
    setChatText('');
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;
  const remoteLabel = remoteConnected ? 'Remote participant' : 'Waiting for participant';

  return (
    <main className="meet-shell">
      <header className="meet-topbar">
        <div>
          <p className="eyebrow">WebRTC Meet</p>
          <h1>{joined ? roomId : 'Start a secure meeting'}</h1>
        </div>
        <div className="meeting-status">
          <span className={joined ? 'status-dot online' : 'status-dot'} />
          <span>{status}</span>
        </div>
      </header>

      <section className={joined ? 'meet-layout in-call' : 'meet-layout'}>
        <div className="stage">
          <div className={remoteConnected ? 'video-tile remote-tile connected' : 'video-tile remote-tile'}>
            <video ref={remoteVideoRef} autoPlay playsInline />
            {!remoteConnected && (
              <div className="empty-video">
                <span>{roomId.slice(0, 2)}</span>
                <strong>Share the room link</strong>
                <p>Another browser or device can join this room to start the call.</p>
              </div>
            )}
            <div className="tile-label">{remoteLabel}</div>
          </div>

          <div className="video-tile local-tile">
            <video ref={localVideoRef} autoPlay playsInline muted />
            {!cameraOn && <div className="camera-off">Camera off</div>}
            <div className="tile-label">You</div>
          </div>
        </div>

        <aside className="side-panel">
          {!joined && (
            <div className="join-card">
              <label>
                Your name
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                Room code
                <input value={roomId} onChange={(event) => setRoomId(normalizeRoom(event.target.value))} />
              </label>
              <button type="button" onClick={joinRoom}>Start / join room</button>
              <button type="button" className="secondary" onClick={copyLink}>{copyLabel}</button>
            </div>
          )}

          {joined && (
            <>
              <div className="side-tabs">
                <button type="button" className={sidePanel === 'chat' ? 'active' : ''} onClick={() => setSidePanel('chat')}>Chat</button>
                <button type="button" className={sidePanel === 'people' ? 'active' : ''} onClick={() => setSidePanel('people')}>People</button>
              </div>

              {sidePanel === 'people' ? (
                <div className="people-list">
                  <strong>{users.length} participants</strong>
                  {users.map((user) => <span key={user.id}>{user.name}</span>)}
                  <div className="diagnostics">
                    <strong>Connection</strong>
                    {diagnostics.length === 0 ? <p>No connection events yet.</p> : diagnostics.map((item) => <p key={item}>{item}</p>)}
                  </div>
                </div>
              ) : (
                <div className="chat-panel">
                  <div className="messages">
                    {messages.length === 0 ? <p>No messages yet.</p> : messages.map((message) => (
                      <article key={message.id}>
                        <strong>{message.author}</strong>
                        <p>{message.text}</p>
                      </article>
                    ))}
                  </div>
                  <form onSubmit={sendMessage}>
                    <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Send a message" />
                    <button type="submit">Send</button>
                  </form>
                </div>
              )}
            </>
          )}
        </aside>
      </section>

      <footer className="control-bar">
        <button type="button" className={micOn ? 'round-control' : 'round-control muted'} onClick={toggleMic} disabled={!joined}>
          {micOn ? 'Mic' : 'Muted'}
        </button>
        <button type="button" className={cameraOn ? 'round-control' : 'round-control muted'} onClick={toggleCamera} disabled={!joined}>
          {cameraOn ? 'Camera' : 'Hidden'}
        </button>
        <button type="button" className="round-control" onClick={copyLink}>{copyLabel}</button>
        <button type="button" className="round-control leave" onClick={() => leaveRoom()} disabled={!joined}>Leave</button>
      </footer>
    </main>
  );
};

export default WebRTC;
