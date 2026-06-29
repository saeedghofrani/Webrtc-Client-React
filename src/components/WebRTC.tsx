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

interface RemoteStream {
  peerId: string;
  name: string;
  stream: MediaStream | null;
  connected: boolean;
}

interface DeviceState {
  camera: 'unknown' | 'ready' | 'missing' | 'blocked';
  microphone: 'unknown' | 'ready' | 'missing' | 'blocked';
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

const RemoteVideoTile: React.FC<{ remote: RemoteStream }> = ({ remote }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = remote.stream;
  }, [remote.stream]);

  return (
    <div className={remote.connected ? 'video-tile remote-tile connected' : 'video-tile remote-tile'}>
      <video ref={videoRef} autoPlay playsInline />
      {!remote.connected && (
        <div className="empty-video compact">
          <span>{remote.name.slice(0, 2).toUpperCase()}</span>
          <strong>Connecting</strong>
        </div>
      )}
      <div className="tile-label">{remote.name || 'Remote participant'}</div>
    </div>
  );
};

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
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [deviceState, setDeviceState] = useState<DeviceState>({ camera: 'unknown', microphone: 'unknown' });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomIdRef = useRef(roomId);
  const usersRef = useRef<RoomUser[]>([]);
  const queuedCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  useEffect(() => {
    roomIdRef.current = roomId;
    window.history.replaceState(null, '', `#${roomId}`);
  }, [roomId]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

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
      socketRef.current = io(endpoint, { transports: ['polling'], upgrade: false });
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
      setRemoteStreams((current) => current.map((remote) => ({
        ...remote,
        name: roomUsers.find((user) => user.id === remote.peerId)?.name || remote.name,
      })));
    });
    socket.on('peer-ready', async ({ peerId, name: peerName }: { peerId: string; name: string }) => {
      addDiagnostic(`Peer ready: ${peerName || peerId}`);
      setStatus(`${peerName || 'Peer'} joined. Connecting...`);
      upsertRemote(peerId, peerName || 'Guest');
      await createOffer(peerId);
    });
    socket.on('offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      addDiagnostic('Received offer');
      upsertRemote(from, findUserName(from));
      const peer = await ensurePeer(from);
      await peer.setRemoteDescription(offer);
      await flushQueuedCandidates(from);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit('answer', { roomId: roomIdRef.current, to: from, answer });
      setStatus('Answer sent. Establishing media...');
    });
    socket.on('answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      const peer = peersRef.current.get(from);
      if (!peer) return;
      addDiagnostic('Received answer');
      await peer.setRemoteDescription(answer);
      await flushQueuedCandidates(from);
      setStatus('Media negotiation complete');
    });
    socket.on('ice-candidate', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      if (!candidate) return;
      const peer = peersRef.current.get(from);
      if (!peer?.remoteDescription) {
        queueCandidate(from, candidate);
        return;
      }
      addDiagnostic('Received ICE candidate');
      await peer.addIceCandidate(candidate);
    });
    socket.on('chat-message', (message: ChatMessage) => {
      setMessages((current) => [...current, message]);
    });
    socket.on('peer-left', ({ peerId }: { peerId: string }) => {
      addDiagnostic('Peer left');
      setStatus('The other participant left');
      removePeer(peerId);
    });
  }

  async function startMedia() {
    if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      setStatus('Camera and microphone require HTTPS. Use the deployed HTTPS meeting URL.');
      return null;
    }
    if (!localStreamRef.current) {
      if (!window.navigator.mediaDevices?.getUserMedia) {
        setDeviceState({ camera: 'missing', microphone: 'missing' });
        setStatus('This browser cannot access camera or microphone devices.');
        return null;
      }
      let stream: MediaStream;
      try {
        stream = await window.navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (error) {
        const deviceError = error instanceof DOMException ? error.name : '';
        const blocked = ['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(deviceError);
        const missing = ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(deviceError);
        setDeviceState({
          camera: blocked ? 'blocked' : missing ? 'missing' : 'unknown',
          microphone: blocked ? 'blocked' : missing ? 'missing' : 'unknown',
        });
        if (blocked) {
          setStatus('Camera or microphone permission is blocked in this browser.');
        } else if (missing) {
          setStatus('No working camera or microphone was found on this device.');
        } else {
          setStatus(error instanceof Error ? error.message : 'Could not access camera or microphone.');
        }
        return null;
      }
      localStreamRef.current = stream;
      setDeviceState({
        camera: stream.getVideoTracks().length > 0 ? 'ready' : 'missing',
        microphone: stream.getAudioTracks().length > 0 ? 'ready' : 'missing',
      });
      setMicOn(stream.getAudioTracks().some((track) => track.enabled));
      setCameraOn(stream.getVideoTracks().some((track) => track.enabled));
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    return localStreamRef.current;
  }

  function findUserName(peerId: string) {
    return usersRef.current.find((user) => user.id === peerId)?.name || 'Guest';
  }

  function upsertRemote(peerId: string, peerName: string) {
    setRemoteStreams((current) => {
      const existing = current.find((remote) => remote.peerId === peerId);
      if (existing) {
        return current.map((remote) => (
          remote.peerId === peerId ? { ...remote, name: peerName || remote.name } : remote
        ));
      }
      return [...current, { peerId, name: peerName || 'Guest', stream: null, connected: false }];
    });
  }

  function updateRemote(peerId: string, updates: Partial<RemoteStream>) {
    setRemoteStreams((current) => current.map((remote) => (
      remote.peerId === peerId ? { ...remote, ...updates } : remote
    )));
  }

  async function ensurePeer(peerId: string) {
    const stream = await startMedia();
    if (!stream) throw new Error('Media unavailable');
    const existingPeer = peersRef.current.get(peerId);
    if (existingPeer) return existingPeer;

    const peer = new RTCPeerConnection({ iceServers });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      addDiagnostic(`Sending ICE candidate: ${event.candidate.type || 'candidate'}`);
      getSocket().emit('ice-candidate', {
        roomId: roomIdRef.current,
        to: peerId,
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
      addDiagnostic(`Remote ${event.track.kind} track received`);
      updateRemote(peerId, { stream: remoteStream || null, connected: Boolean(remoteStream) });
      setStatus('Connected');
    };
    peer.onconnectionstatechange = () => {
      addDiagnostic(`Peer state: ${peer.connectionState}`);
      if (peer.connectionState === 'connected') {
        updateRemote(peerId, { connected: true });
        setStatus('Connected');
      }
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        updateRemote(peerId, { connected: false });
        setStatus(`Peer connection ${peer.connectionState}`);
      }
    };
    peersRef.current.set(peerId, peer);
    return peer;
  }

  function queueCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const queued = queuedCandidatesRef.current.get(peerId) || [];
    queuedCandidatesRef.current.set(peerId, [...queued, candidate]);
  }

  async function flushQueuedCandidates(peerId: string) {
    const peer = peersRef.current.get(peerId);
    if (!peer?.remoteDescription) return;
    const queued = queuedCandidatesRef.current.get(peerId) || [];
    queuedCandidatesRef.current.delete(peerId);
    for (const candidate of queued) {
      await peer.addIceCandidate(candidate);
    }
  }

  async function joinRoom() {
    try {
      const cleanRoom = normalizeRoom(roomId) || randomRoom();
      setRoomId(cleanRoom);
      roomIdRef.current = cleanRoom;
      setStatus('Starting camera and microphone...');
      await startMedia();
      getSocket().emit('join-room', { roomId: cleanRoom, name: name.trim() || 'Guest' });
      setJoined(true);
      setStatus(`Joined ${cleanRoom}. Waiting for another participant.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not access camera/microphone');
    }
  }

  async function createOffer(peerId: string) {
    const peer = await ensurePeer(peerId);
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
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    queuedCandidatesRef.current.clear();
    setRemoteStreams([]);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (reload) window.location.reload();
  }

  function removePeer(peerId: string) {
    peersRef.current.get(peerId)?.close();
    peersRef.current.delete(peerId);
    queuedCandidatesRef.current.delete(peerId);
    setRemoteStreams((current) => current.filter((remote) => remote.peerId !== peerId));
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
  const hasRemoteStreams = remoteStreams.length > 0;

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
          <div className={hasRemoteStreams ? 'remote-grid has-remotes' : 'remote-grid'}>
            {!hasRemoteStreams && (
              <div className="empty-video">
                <span>{roomId.slice(0, 2)}</span>
                <strong>Share the room link</strong>
                <p>Another browser or device can join this room to start the call.</p>
              </div>
            )}
            {remoteStreams.map((remote) => (
              <RemoteVideoTile key={remote.peerId} remote={remote} />
            ))}
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
                  <div className="device-status">
                    <strong>Devices</strong>
                    <p>Camera: {deviceState.camera}</p>
                    <p>Microphone: {deviceState.microphone}</p>
                  </div>
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
