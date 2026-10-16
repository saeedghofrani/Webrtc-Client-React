import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { Camera, Video, VideoOff, Mic, MicOff, PhoneOff, Link, Check, MessageSquare, Users, Settings, X, Send, MonitorUp, RefreshCw, ArrowRight, Headphones, Maximize, Minimize, ShieldCheck } from 'lucide-react';
import { normalizeRoom, newRoom, useCall } from './useCall';

function VideoElement({ stream, muted = false, label }: { stream: MediaStream | null; muted?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
    return () => { element.srcObject = null; };
  }, [stream]);
  return <><video ref={ref} autoPlay playsInline muted={muted} aria-label={label} />{blocked && <button className="play-media" onClick={() => { void ref.current?.play().then(() => setBlocked(false)); }}>Play audio and video</button>}</>;
}

const WebRTC: React.FC = () => {
  const [room, setRoom] = useState(() => normalizeRoom(window.location.hash.slice(1)) || newRoom());
  const [name, setName] = useState(() => { try { return localStorage.getItem('meet-name') || ''; } catch { return ''; } });
  const call = useCall(room, name);
  const [panel, setPanel] = useState<'chat' | 'people' | 'settings' | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [unread, setUnread] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const messageCount = useRef(0);
  const invite = `${window.location.origin}${window.location.pathname}#${room}`;
  const other = call.users.find((user) => user.id !== call.selfId);

  useEffect(() => { window.history.replaceState(null, '', `#${room}`); }, [room]);
  useEffect(() => {
    if (panel !== 'chat' && call.messages.length > messageCount.current) setUnread((n) => n + call.messages.length - messageCount.current);
    messageCount.current = call.messages.length;
    messagesEnd.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [call.messages, panel]);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('fullscreenchange', changed); document.removeEventListener('keydown', close); };
  }, []);

  function openPanel(next: typeof panel) { setPanel(panel === next ? null : next); if (next === 'chat') setUnread(0); }
  async function copy() {
    try { await navigator.clipboard.writeText(invite); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { call.setNotice('Could not copy the link. Select the invitation link below.'); setPanel('people'); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    try { localStorage.setItem('meet-name', name.trim()); } catch { /* Private browsing may disable storage. */ }
    void call.join();
  }
  function send(event: FormEvent) { event.preventDefault(); if (text.trim() && call.chat(text.trim())) setText(''); }
  async function toggleFullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { call.setNotice('Full screen is unavailable in this browser.'); }
  }
  const iconButton = (label: string, icon: React.ReactNode, action: () => void, active = false, extra = '') => (
    <button type="button" className={`icon-button ${active ? 'selected' : ''} ${extra}`} title={label} aria-label={label} onClick={action}>{icon}</button>
  );

  return <main className={`meet-shell ${call.joined ? 'in-call-shell' : 'prejoin-shell'} ${panel && call.joined ? 'panel-open' : ''}`}>
    <header className="meet-topbar">
      <div className="brand" aria-label="Together Meet"><span className="brand-icon"><Video size={23} /></span><span>Together<span className="brand-light"> Meet</span></span></div>
      <div className="meeting-status" role="status" aria-live="polite"><span className={`status-dot ${call.remote?.connected ? 'online' : ''}`} />{call.status}</div>
      {call.joined && <div className="room-code">{room}</div>}
    </header>

    {call.notice && <div className="notice" role="alert"><span>{call.notice}</span>{iconButton('Dismiss notification', <X size={18} />, () => call.setNotice(''))}</div>}

    {!call.joined ? <section className="prejoin">
      <div className="prejoin-preview">
        <div className="preview-mark"><Video size={40} strokeWidth={1.5} /></div>
        <h1>A little closer.</h1>
        <p>A room for the two of you.</p>
        <div className="preview-bottom"><span><ShieldCheck size={16} /> Encrypted media</span><span><Users size={16} /> 2 people</span></div>
      </div>
      <form className="join-card" onSubmit={submit}>
        <span className="eyebrow">YOUR PRIVATE CALL</span>
        <h2>Ready to meet?</h2>
        <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Enter your name" autoComplete="given-name" disabled={call.busy} required /></label>
        <label>Room code<div className="room-input"><input value={room} onChange={(e) => setRoom(normalizeRoom(e.target.value))} maxLength={24} required disabled={call.busy} spellCheck={false} />{iconButton('Create a new room', <RefreshCw size={18} />, () => setRoom(newRoom()))}</div></label>
        <button className="primary join-button" disabled={call.busy || !room || !name.trim()} type="submit">{call.busy ? 'Connecting...' : 'Join call'}<ArrowRight size={19} /></button>
        <button className="secondary" type="button" disabled={call.busy || !name.trim() || !room} onClick={() => void call.join(true)}><Headphones size={18} />Join to listen</button>
        <button className="text-button" type="button" onClick={() => void copy()}>{copied ? <Check size={17} /> : <Link size={17} />}{copied ? 'Link copied' : 'Copy invitation link'}</button>
        {call.busy && <button className="text-button" type="button" onClick={call.leave}>Cancel</button>}
      </form>
    </section> : <>
      <section className="meet-layout in-call">
        <div className="stage">
          <div className={`video-tile remote-tile ${call.remote?.connected ? 'connected' : ''} ${other?.sharing ? 'screen-content' : ''}`}>
            {call.remote && <VideoElement stream={call.remote.stream} label="Other participant" />}
            {(!call.remote || (other?.cameraOn === false && !other?.sharing)) && <div className="empty-video">
              <div className="avatar">{other ? other.name.slice(0, 1).toUpperCase() : <Users size={30} />}</div>
              <h2>{other?.name || 'Your room is ready'}</h2>
              <p>{other ? other.micOn === false ? 'Microphone muted' : 'Camera off' : 'Waiting for the other person to join.'}</p>
              {!other && <button className="secondary" onClick={() => void copy()}><Link size={18} />{copied ? 'Link copied' : 'Copy invitation'}</button>}
            </div>}
            {call.remote && <div className="tile-label">{other?.micOn === false && <MicOff size={15} />}{other?.name || 'Connecting...'}{other?.sharing && <span> · presenting</span>}</div>}
            {call.remote && !call.remote.connected && <span className="connecting-badge">Connecting...</span>}
          </div>
          <div className={`video-tile local-tile ${call.sharing ? 'screen-content' : ''}`}>
            <VideoElement stream={call.local} muted label="Your preview" />
            {!call.cameraOn && !call.sharing && <div className="camera-off"><VideoOff size={24} /></div>}
            <div className="tile-label">{!call.micOn && <MicOff size={13} />}You{call.sharing ? ' · presenting' : ''}</div>
          </div>
        </div>
        {panel && <aside className="side-panel" aria-label={`${panel} panel`}>
          <div className="panel-heading"><h2>{panel === 'chat' ? 'Messages' : panel === 'people' ? 'In this call' : 'Call settings'}</h2>{iconButton('Close panel', <X size={20} />, () => setPanel(null))}</div>
          {panel === 'chat' ? <div className="chat-panel">
            <div className="messages" role="log" aria-label="Messages">{!call.messages.length && <p className="panel-empty">No messages yet.</p>}{call.messages.map((message) => <article key={message.id}><div className="message-meta"><strong>{message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></article>)}<div ref={messagesEnd} /></div>
            <form onSubmit={send}><input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Send a message" maxLength={2000} autoComplete="off" /><button className="icon-button selected" aria-label="Send message" title="Send message" disabled={!text.trim()}><Send size={19} /></button></form>
          </div> : panel === 'people' ? <div className="panel-body">
            <p className="section-caption">PARTICIPANTS · {call.users.length}/2</p>
            {call.users.map((user) => <div className="person" key={user.id}><span className="person-avatar">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}{user.id === call.selfId ? ' (you)' : ''}</span>{user.micOn === false && <MicOff size={17} />}</div>)}
            <hr /><h3>Invitation</h3><input readOnly value={invite} aria-label="Invitation link" onFocus={(e) => e.target.select()} /><button className="secondary" onClick={() => void copy()}><Link size={17} />{copied ? 'Copied' : 'Copy link'}</button>
          </div> : <div className="panel-body settings-body">
            <label>Microphone<select aria-label="Microphone" value={call.local?.getAudioTracks()[0]?.getSettings().deviceId || ''} onChange={(e) => void call.replaceDevice('audio', e.target.value)}><option value="" disabled>Select microphone</option>{call.devices.filter((d) => d.kind === 'audioinput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select></label>
            <label>Camera<select aria-label="Camera" value={call.sharing ? '' : call.local?.getVideoTracks()[0]?.getSettings().deviceId || ''} onChange={(e) => void call.replaceDevice('video', e.target.value)}><option value="" disabled>Select camera</option>{call.devices.filter((d) => d.kind === 'videoinput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}</select></label>
            <label className="toggle-row"><span>Data saver</span><input type="checkbox" checked={call.dataSaver} onChange={(e) => call.setDataSaver(e.target.checked)} /></label>
            <hr /><h3>Connection</h3><p className="quality">{call.quality}</p><button className="secondary" onClick={call.recover}><RefreshCw size={17} />Reconnect media</button>
          </div>}
        </aside>}
      </section>
      <footer className="control-bar">
        <div className="call-detail"><span>{room}</span><small>{call.quality}</small></div>
        <div className="call-controls">
          {iconButton(call.micOn ? 'Mute microphone' : 'Unmute microphone', call.micOn ? <Mic /> : <MicOff />, () => call.toggle('audio'), false, call.micOn ? '' : 'muted')}
          {iconButton(call.cameraOn ? 'Turn camera off' : 'Turn camera on', call.cameraOn ? <Video /> : <VideoOff />, () => call.toggle('video'), false, call.cameraOn ? '' : 'muted')}
          {typeof navigator.mediaDevices?.getDisplayMedia === 'function' && iconButton(call.sharing ? 'Stop sharing screen' : 'Share screen', <MonitorUp />, () => void call.toggleShare(), call.sharing, 'share-control')}
          {iconButton('Leave call', <PhoneOff />, () => { call.leave(); setPanel(null); }, false, 'leave')}
        </div>
        <div className="utility-controls">
          {iconButton('Participants', <Users size={21} />, () => openPanel('people'), panel === 'people')}
          <div className="chat-control">{iconButton('Messages', <MessageSquare size={21} />, () => openPanel('chat'), panel === 'chat')}{unread > 0 && <span className="unread">{unread > 9 ? '9+' : unread}</span>}</div>
          {iconButton('Settings', <Settings size={21} />, () => openPanel('settings'), panel === 'settings')}
          {document.fullscreenEnabled && iconButton(fullscreen ? 'Exit full screen' : 'Full screen', fullscreen ? <Minimize size={21} /> : <Maximize size={21} />, () => void toggleFullscreen(), false, 'fullscreen-control')}
        </div>
      </footer>
    </>}
    {!call.joined && <footer className="prejoin-footer"><Camera size={15} /> Together Meet</footer>}
  </main>;
};

export default WebRTC;
