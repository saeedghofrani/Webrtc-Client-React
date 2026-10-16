import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export interface Participant { id: string; name: string; micOn?: boolean; cameraOn?: boolean; sharing?: boolean }
export interface Message { id: string; author: string; text: string; createdAt: string }
export interface Remote { id: string; stream: MediaStream; connected: boolean }
const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const video: MediaTrackConstraints = { width: { ideal: 640, max: 960 }, height: { ideal: 360, max: 540 }, frameRate: { ideal: 24, max: 24 }, facingMode: 'user' };
export const normalizeRoom = (value: string) => value.replace(/[^a-z0-9-]/gi, '').slice(0, 24).toUpperCase();
export const newRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => (n % 36).toString(36)).join('').toUpperCase();
const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const turn = process.env.REACT_APP_TURN_URLS?.split(',').map((s) => s.trim()).filter(Boolean);
if (turn?.length) iceServers.push({ urls: turn, username: process.env.REACT_APP_TURN_USERNAME, credential: process.env.REACT_APP_TURN_CREDENTIAL });
function sessionId() {
  try {
    const saved = sessionStorage.getItem('meet-session');
    if (saved) return saved;
    const id = crypto.randomUUID(); sessionStorage.setItem('meet-session', id); return id;
  } catch { return newRoom() + newRoom(); }
}

export function useCall(room: string, name: string) {
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready when you are');
  const [notice, setNotice] = useState('');
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [users, setUsers] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [quality, setQuality] = useState('Waiting');
  const [dataSaver, setDataSaver] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const socket = useRef<Socket | null>(null);
  const session = useRef(sessionId());
  const peer = useRef<RTCPeerConnection | null>(null);
  const peerId = useRef<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const display = useRef<MediaStream | null>(null);
  const wanted = useRef(false);
  const joining = useRef(false);
  const generation = useRef(0);
  const candidates = useRef<RTCIceCandidateInit[]>([]);
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const joinTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ room, name, micOn, cameraOn, sharing, dataSaver });
  latest.current = { room, name, micOn, cameraOn, sharing, dataSaver };

  function report(error: unknown) { setNotice(error instanceof Error ? error.message : 'Something went wrong. Please retry.'); }
  function closePeer() {
    clearTimeout(retryTimer.current);
    const old = peer.current;
    peer.current = null;
    peerId.current = null;
    if (old) { old.onconnectionstatechange = null; old.oniceconnectionstatechange = null; old.ontrack = null; old.onicecandidate = null; old.close(); }
    candidates.current = [];
    setRemote(null);
    setQuality('Waiting');
  }
  function mediaState() {
    socket.current?.emit('media-state', {
      micOn: stream.current?.getAudioTracks().some((t) => t.enabled) || false,
      cameraOn: stream.current?.getVideoTracks().some((t) => t.enabled) || false,
      sharing: Boolean(display.current),
    });
  }
  async function listDevices() {
    if (navigator.mediaDevices?.enumerateDevices) setDevices(await navigator.mediaDevices.enumerateDevices());
  }
  async function configureSender(sender: RTCRtpSender) {
    if (!sender.track) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = sender.track.kind === 'audio' ? 40000 : latest.current.dataSaver ? 220000 : display.current ? 1100000 : 600000;
    if (sender.track.kind === 'video') p.encodings[0].maxFramerate = display.current ? 15 : latest.current.dataSaver ? 15 : 24;
    try { await sender.setParameters(p); } catch { /* Some browsers only accept encoding changes after negotiation. */ }
  }
  function send(event: string, payload: object) {
    if (!socket.current?.connected || !wanted.current) return;
    socket.current.emit(event, { roomId: latest.current.room, to: peerId.current, ...payload });
  }
  function ensurePeer(id: string, answering = false) {
    if (peer.current && peerId.current === id) return peer.current;
    if (peer.current) closePeer();
    const pc = new RTCPeerConnection({ iceServers });
    peer.current = pc;
    peerId.current = id;
    const received = new MediaStream();
    setRemote({ id, stream: received, connected: false });
    if (!answering) for (const kind of ['audio', 'video'] as const) {
      const track = kind === 'video' ? display.current?.getVideoTracks()[0] || stream.current?.getVideoTracks()[0] : stream.current?.getAudioTracks()[0];
      pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: stream.current ? [stream.current] : [] });
    }
    pc.ontrack = ({ track }) => {
      if (peer.current !== pc) return;
      if (!received.getTracks().some((t) => t.id === track.id)) received.addTrack(track);
      setRemote({ id, stream: received, connected: pc.connectionState === 'connected' });
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && peer.current === pc) send('ice-candidate', { candidate: candidate.toJSON() });
    };
    const recover = () => {
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        if (peer.current === pc && pc.connectionState !== 'connected') socket.current?.emit('recover-call');
      }, 3500);
    };
    pc.onconnectionstatechange = () => {
      if (peer.current !== pc) return;
      const connected = pc.connectionState === 'connected';
      setRemote({ id, stream: received, connected });
      if (connected) {
        clearTimeout(retryTimer.current);
        setStatus('Connected');
        pc.getSenders().forEach((s) => void configureSender(s));
      } else if (['disconnected', 'failed'].includes(pc.connectionState)) {
        setStatus('Reconnecting call...');
        recover();
      }
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') recover(); };
    setStatus('Connecting call...');
    return pc;
  }
  async function flush(pc: RTCPeerConnection) {
    const pending = candidates.current.splice(0);
    for (const item of pending) await pc.addIceCandidate(item);
  }
  async function offer(id: string, restart = false) {
    const pc = ensurePeer(id);
    if (pc.signalingState !== 'stable') return;
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: restart }));
    if (peer.current === pc) send('offer', { offer: pc.localDescription });
  }
  function enqueue(action: () => Promise<unknown>) {
    const epoch = generation.current;
    serial.current = serial.current.then(() => { if (wanted.current && generation.current === epoch) return action(); }).catch(report);
  }
  function emitJoin() {
    const current = latest.current;
    socket.current?.emit('join-room', { roomId: current.room, name: current.name.trim() || 'Guest', sessionId: session.current, micOn: current.micOn, cameraOn: current.cameraOn });
  }
  function connect() {
    const s = io(process.env.REACT_APP_SIGNALING_URL || window.location.origin, { transports: ['polling'], upgrade: false, autoConnect: false });
    socket.current = s;
    s.on('connect', () => { if (wanted.current) { generation.current++; closePeer(); emitJoin(); } });
    s.on('disconnect', () => { if (wanted.current) setStatus('Connection lost. Reconnecting...'); });
    s.on('connect_error', () => setStatus('Server unavailable. Retrying...'));
    s.on('room-joined', ({ users: people }) => {
      clearTimeout(joinTimer.current);
      joining.current = false;
      setBusy(false);
      setJoined(true);
      setUsers(people);
      setStatus('Waiting for the other person');
      mediaState();
    });
    s.on('room-full', () => { leave(); setNotice('This room already has two people. Try another room or wait for a place.'); });
    s.on('room-users', (people: Participant[]) => setUsers(people));
    s.on('peer-ready', ({ peerId: id }) => enqueue(() => offer(id)));
    s.on('restart-ice', ({ peerId: id }) => enqueue(() => offer(id, true)));
    s.on('offer', ({ from, offer: description }) => enqueue(async () => {
      const pc = ensurePeer(from, true);
      if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(description);
      // Reuse the offer's transceivers; creating new ones here can answer recvonly.
      for (const transceiver of pc.getTransceivers()) {
        const kind = transceiver.receiver.track.kind;
        const track = kind === 'video' ? display.current?.getVideoTracks()[0] || stream.current?.getVideoTracks()[0] : stream.current?.getAudioTracks()[0];
        await transceiver.sender.replaceTrack(track || null);
        transceiver.direction = 'sendrecv';
      }
      await flush(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      if (peer.current === pc) send('answer', { answer: pc.localDescription });
    }));
    s.on('answer', ({ from, answer }) => enqueue(async () => {
      const pc = peer.current;
      if (!pc || peerId.current !== from || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(answer);
      await flush(pc);
    }));
    s.on('ice-candidate', ({ from, candidate }) => enqueue(async () => {
      if (peerId.current && peerId.current !== from) return;
      if (peer.current?.remoteDescription) await peer.current.addIceCandidate(candidate);
      else if (candidates.current.length < 100) candidates.current.push(candidate);
    }));
    s.on('peer-left', ({ peerId: id }) => {
      if (peerId.current === id) { closePeer(); setStatus('The other person left. Waiting...'); }
    });
    s.on('chat-message', (message: Message) => setMessages((old) => [...old.slice(-199), message]));
    s.connect();
  }
  async function join(listenOnly = false) {
    if (joining.current || wanted.current) return;
    joining.current = true;
    setBusy(true);
    setNotice('');
    const epoch = ++generation.current;
    setStatus('Preparing your devices...');
    let captured: MediaStream | null = null;
    try {
      if (!listenOnly) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS and a supported browser. You can still join to listen.');
        try { captured = await navigator.mediaDevices.getUserMedia({ audio, video }); }
        catch (error) {
          if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) throw new Error('Device permission is blocked. Allow access in your browser, or join to listen.');
          // A missing camera must not prevent an audio call, and vice versa.
          try { captured = await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
          catch { captured = await navigator.mediaDevices.getUserMedia({ audio: false, video }); }
        }
      }
      if (generation.current !== epoch) { captured?.getTracks().forEach((t) => t.stop()); return; }
      stream.current = captured || new MediaStream();
      setLocal(stream.current);
      const hasAudio = stream.current.getAudioTracks().length > 0;
      const hasVideo = stream.current.getVideoTracks().length > 0;
      setMicOn(hasAudio); setCameraOn(hasVideo);
      latest.current = { ...latest.current, micOn: hasAudio, cameraOn: hasVideo };
      if (!listenOnly && (!hasAudio || !hasVideo)) setNotice(hasAudio ? 'Camera unavailable. Joined with audio.' : 'Microphone unavailable. Joined with video.');
      void listDevices().catch(report);
      wanted.current = true;
      setStatus('Joining room...');
      joinTimer.current = setTimeout(() => { if (joining.current) { leave(); setNotice('The server did not respond. Please try again.'); } }, 20000);
      connect();
    } catch (error) {
      if (epoch !== generation.current) return;
      captured?.getTracks().forEach((t) => t.stop());
      joining.current = false; setBusy(false); setStatus('Ready when you are'); report(error);
    }
  }
  function leave() {
    generation.current++;
    wanted.current = false; joining.current = false;
    clearTimeout(joinTimer.current);
    closePeer();
    socket.current?.removeAllListeners(); socket.current?.disconnect(); socket.current = null;
    display.current?.getTracks().forEach((t) => t.stop()); display.current = null;
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    setLocal(null); setUsers([]); setJoined(false); setBusy(false); setSharing(false); setMessages([]); setStatus('Call ended');
  }
  function toggle(kind: 'audio' | 'video') {
    const tracks = kind === 'audio' ? stream.current?.getAudioTracks() : stream.current?.getVideoTracks();
    if (!tracks?.length) { setNotice(`No ${kind === 'audio' ? 'microphone' : 'camera'} selected. Open settings to choose a device.`); return; }
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => { t.enabled = enabled; });
    if (kind === 'audio') setMicOn(enabled); else setCameraOn(enabled);
    mediaState();
  }
  async function replaceDevice(kind: 'audio' | 'video', deviceId: string) {
    const epoch = generation.current;
    let next: MediaStream | undefined;
    try {
      next = await navigator.mediaDevices.getUserMedia(kind === 'audio'
        ? { audio: { ...audio, deviceId: { exact: deviceId } }, video: false }
        : { audio: false, video: { ...video, deviceId: { exact: deviceId } } });
      if (epoch !== generation.current || !stream.current) { next.getTracks().forEach((t) => t.stop()); return; }
      const track = next.getTracks()[0];
      const transceiver = peer.current?.getTransceivers().find((t) => t.receiver.track.kind === kind);
      if (!(kind === 'video' && display.current)) await transceiver?.sender.replaceTrack(track);
      stream.current.getTracks().filter((t) => t.kind === kind).forEach((t) => { stream.current?.removeTrack(t); t.stop(); });
      stream.current.addTrack(track);
      setLocal(new MediaStream(stream.current.getTracks()));
      if (kind === 'audio') setMicOn(true); else setCameraOn(true);
      mediaState(); await listDevices();
    } catch (error) { next?.getTracks().forEach((t) => t.stop()); report(error); }
  }
  async function stopSharing() {
    const previous = display.current;
    display.current = null;
    setSharing(false);
    previous?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    const sender = peer.current?.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
    await sender?.replaceTrack(stream.current?.getVideoTracks()[0] || null);
    setLocal(stream.current ? new MediaStream(stream.current.getTracks()) : null);
    mediaState();
  }
  async function toggleShare() {
    if (display.current) { await stopSharing().catch(report); return; }
    const epoch = generation.current;
    try {
      const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      if (epoch !== generation.current) { next.getTracks().forEach((t) => t.stop()); return; }
      display.current = next;
      const sender = peer.current?.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
      await sender?.replaceTrack(next.getVideoTracks()[0]);
      next.getVideoTracks()[0].onended = () => { void stopSharing().catch(report); };
      setLocal(next); setSharing(true); mediaState();
      if (sender) await configureSender(sender);
    } catch (error) { if (!(error instanceof DOMException && error.name === 'NotAllowedError')) report(error); }
  }
  function chat(text: string) {
    if (!socket.current?.connected) { setNotice('Reconnecting. Please send your message again shortly.'); return false; }
    socket.current.emit('chat-message', { text }); return true;
  }
  useEffect(() => {
    peer.current?.getSenders().forEach((s) => void configureSender(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSaver]);
  useEffect(() => {
    const changed = () => { void listDevices().catch(report); };
    navigator.mediaDevices?.addEventListener?.('devicechange', changed);
    const interval = setInterval(() => {
      const pc = peer.current;
      if (!pc || pc.connectionState !== 'connected') return;
      void pc.getStats().then((stats) => {
        if (pc !== peer.current) return;
        stats.forEach((item) => {
          if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
            const ms = Math.round((item.currentRoundTripTime || 0) * 1000);
            const relayed = stats.get(item.localCandidateId)?.candidateType === 'relay' || stats.get(item.remoteCandidateId)?.candidateType === 'relay';
            setQuality(`${ms > 300 ? 'Weak' : 'Good'} connection · ${ms} ms${relayed ? ' · Relay' : ''}`);
          }
        });
      }).catch(() => {});
    }, 3000);
    return () => { clearInterval(interval); navigator.mediaDevices?.removeEventListener?.('devicechange', changed); leave(); };
    // The socket and media lifetimes are owned by refs, not render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { joined, busy, status, notice, setNotice, local, remote, users, messages, micOn, cameraOn, sharing, quality, dataSaver, setDataSaver, devices, join, leave, toggle, toggleShare, replaceDevice, chat, recover: () => socket.current?.emit('recover-call'), selfId: socket.current?.id };
}
