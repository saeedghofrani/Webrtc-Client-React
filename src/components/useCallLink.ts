import { useEffect, useState } from 'react';

export function useCallLink(setRoom: (room: string) => void) {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('call') || '');
  const [loading, setLoading] = useState(Boolean(token));
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeCall, setActiveCall] = useState('');
  const base = `${process.env.REACT_APP_SIGNALING_URL || ''}/api/call-links`;
  async function request(path: string, method = 'GET', body?: object) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Incoming calls unavailable (${response.status}).`);
    return data;
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(token ? `/${encodeURIComponent(token)}` : '/config');
        if (cancelled) return;
        setEnabled(data.enabled);
        if (token) setRoom(data.room);
        setLoading(false);
      } catch (cause) {
        if (!cancelled && token) setError(cause instanceof Error ? cause.message : 'Could not open this private link.');
        // A failed private-link lookup stays locked; never join an unrelated random room.
      }
    })();
    return () => { cancelled = true; };
    // setRoom is the stable React setter; request uses the build-time API URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, setRoom]);
  useEffect(() => {
    if (!activeCall) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void request(`/${token}/calls/${activeCall}`).then((data) => {
        if (cancelled) return;
        if (data.status !== 'ringing') { setProgress(`Call ${data.status}.`); setActiveCall(''); }
      }).catch(() => { if (!cancelled) { setError('Could not check the call status.'); setActiveCall(''); } });
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall, token]);
  async function create() {
    setBusy(true); setError('');
    try {
      const data = await request('/', 'POST', {});
      const url = new URL(window.location.href); url.searchParams.set('call', data.token); url.hash = data.room;
      window.history.replaceState(null, '', url); setRoom(data.room); setToken(data.token);
      setProgress('Share this link. The recipient opens it in Together Meet for Android and enables ringing.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function ring(caller: string) {
    setBusy(true); setError('');
    try {
      const data = await request(`/${token}/calls`, 'POST', { caller });
      setActiveCall(data.callId); setProgress('Call alert sent. Waiting for an answer…');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try { await request(`/${token}/calls/${activeCall}/cancel`, 'POST', {}); setActiveCall(''); setProgress('Call cancelled.'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return { token, loading, enabled, error, progress, busy, activeCall, create, ring, cancel };
}
