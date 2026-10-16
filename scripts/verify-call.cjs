const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');

async function main() {
  let web, signaling;
  let base = process.env.TEST_URL;
  if (!base) {
    const app = require('../../webrtc-server/index.js').createSignalingServer();
    signaling = app.io;
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const port = app.server.address().port;
    web = http.createServer((req, res) => {
      if (req.url.startsWith('/socket.io/')) {
        const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        req.pipe(upstream); upstream.on('error', () => { res.writeHead(502); res.end(); }); return;
      }
      const resource = req.url.split('?')[0];
      const target = path.resolve(__dirname, '../build', '.' + (resource === '/' ? '/index.html' : resource));
      if (!target.startsWith(path.resolve(__dirname, '../build') + path.sep)) { res.writeHead(403); res.end(); return; }
      const type = target.endsWith('.js') ? 'application/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      fs.readFile(target, (error, data) => { res.writeHead(error ? 404 : 200, { 'Content-Type': type }); res.end(error ? '' : data); });
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${web.address().port}`;
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'],
  });
  const errors = [];
  const contexts = [];
  const create = async (width = 390, height = 844) => {
    const context = await browser.newContext({ viewport: { width, height }, permissions: ['camera', 'microphone', 'clipboard-write'] });
    contexts.push(context);
    await context.addInitScript(({ relay, transport, turnHost }) => {
      const Native = window.RTCPeerConnection;
      window.__peers = [];
      window.RTCPeerConnection = class extends Native {
        constructor(config) {
          if (turnHost) config.iceServers = config.iceServers.map((s) => ({ ...s, urls: [s.urls].flat().map((u) => u.replace('meet.saeedghofrani.xyz', turnHost)) }));
          if (transport) config.iceServers = config.iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => u.startsWith('turn:') && u.includes(`transport=${transport}`)) })).filter((s) => s.urls.length);
          super({ ...config, ...(relay ? { iceTransportPolicy: 'relay' } : {}) }); window.__peers.push(this);
          this.testIceErrors = [];
          this.addEventListener('icecandidateerror', (e) => this.testIceErrors.push({ code: e.errorCode, message: e.errorText, url: e.url }));
        }
      };
      // Exercise screen-track replacement with a deterministic live source.
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let tick = 0;
        const timer = setInterval(() => { ctx.fillStyle = tick++ % 2 ? '#d03452' : '#219d7b'; ctx.fillRect(0, 0, 640, 360); }, 80);
        const stream = canvas.captureStream(15); window.__display = stream;
        stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    }, { relay: process.env.TEST_RELAY === '1', transport: process.env.TEST_TURN_TRANSPORT, turnHost: process.env.TEST_TURN_HOST });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  const room = 'QA-' + Date.now();
  const join = async (page, name) => {
    await page.goto(`${base}/#${room}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.getByLabel('Your name').fill(name);
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await page.locator('.in-call-shell').waitFor({ timeout: 30000 });
  };
  const live = async (page) => {
    try { await page.waitForFunction(() => {
      const video = document.querySelector('.remote-tile video');
      const pc = window.__peers.filter((p) => p.connectionState !== 'closed').at(-1);
      return pc?.connectionState === 'connected' && video?.readyState >= 2 && !video.paused && video.videoWidth > 0 && video.srcObject.getAudioTracks().some((t) => t.readyState === 'live');
    }, null, { timeout: 30000 }); } catch (error) {
      console.log('Relay diagnostics:', JSON.stringify(await page.evaluate(() => window.__peers.map((p) => ({ gathering: p.iceGatheringState, errors: p.testIceErrors, servers: p.getConfiguration().iceServers.map((s) => ({ urls: s.urls, hasUsername: Boolean(s.username), hasCredential: Boolean(s.credential) })) }))), null, 2));
      console.log('Call failure:', await page.evaluate(() => ({ status: document.querySelector('[role=status]')?.textContent, alerts: [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent), peers: window.__peers.map((p) => ({ connection: p.connectionState, ice: p.iceConnectionState, signaling: p.signalingState, remote: Boolean(p.remoteDescription) })), videos: [...document.querySelectorAll('video')].map((v) => ({ ready: v.readyState, paused: v.paused, width: v.videoWidth, muted: v.muted, tracks: v.srcObject?.getTracks().map((t) => ({ kind: t.kind, state: t.readyState, muted: t.muted })) })) })));
      await page.screenshot({ path: path.resolve(__dirname, '../test-artifacts/failure.png') });
      throw error;
    }
  };
  const stats = (page) => page.evaluate(async () => {
    const pc = window.__peers.filter((p) => p.connectionState !== 'closed').at(-1);
    const result = [];
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') result.push({ kind: s.kind, bytes: s.bytesReceived, frames: s.framesDecoded || 0 }); });
    return result;
  });
  const geometry = async (page) => {
    const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, buttons: [...document.querySelectorAll('.control-bar button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), valid: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; }) }));
    assert.equal(result.overflow, false, 'horizontal overflow');
    result.buttons.forEach((b) => assert.ok(b.valid, `offscreen control: ${b.label}`));
  };
  const artifacts = path.resolve(__dirname, '../test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  try {
    const a = await create(), b = await create(1366, 900), c = await create(320, 740);
    await a.goto(`${base}/#${room}`, { waitUntil: 'networkidle' });
    await a.screenshot({ path: path.join(artifacts, 'mobile-prejoin.png'), fullPage: true });
    await join(a, 'Saeed QA'); await join(b, 'Sister QA');
    await live(a); await live(b);
    console.log('Two-way media connected');
    const before = await stats(a);
    const route = await a.evaluate(async () => {
      const pc = window.__peers.filter((p) => p.connectionState !== 'closed').at(-1);
      const report = await pc.getStats(); let selected;
      report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { const candidate = report.get(s.localCandidateId); selected = { type: candidate.candidateType, relayProtocol: candidate.relayProtocol }; } });
      return selected;
    });
    if (process.env.TEST_RELAY === '1') assert.equal(route.type, 'relay');
    console.log('Selected route:', route);
    await a.getByRole('button', { name: 'Messages', exact: true }).click();
    await a.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello from phone');
    await a.getByRole('button', { name: 'Send message', exact: true }).click();
    await b.getByRole('button', { name: 'Messages', exact: true }).click();
    await b.getByText('Hello from phone', { exact: true }).waitFor();
    await a.screenshot({ path: path.join(artifacts, 'mobile-chat.png') });
    await a.getByRole('button', { name: 'Close panel', exact: true }).click();
    await a.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await a.waitForFunction(() => document.querySelector('.local-tile video').srcObject.getAudioTracks().every((t) => !t.enabled));
    await a.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await b.getByText('Microphone muted', { exact: true }).waitFor();
    await a.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await a.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await a.getByRole('button', { name: 'Share screen', exact: true }).click();
    await a.getByRole('button', { name: 'Stop sharing screen', exact: true }).waitFor();
    await b.getByText('· presenting', { exact: false }).waitFor();
    await a.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    await a.getByRole('button', { name: 'Settings', exact: true }).click();
    await a.evaluate(() => { window.__oldAudio = document.querySelector('.local-tile video').srcObject.getAudioTracks()[0]; });
    await a.getByRole('combobox', { name: 'Microphone', exact: true }).selectOption({ index: 1 });
    await a.waitForFunction(() => window.__oldAudio.readyState === 'ended');
    await a.evaluate(() => { window.__oldVideo = document.querySelector('.local-tile video').srcObject.getVideoTracks()[0]; });
    await a.getByRole('combobox', { name: 'Camera', exact: true }).selectOption({ index: 1 });
    await a.waitForFunction(() => window.__oldVideo.readyState === 'ended');
    await a.getByRole('checkbox', { name: 'Data saver', exact: true }).check();
    await a.getByRole('button', { name: 'Reconnect media', exact: true }).click();
    await a.getByRole('button', { name: 'Close panel', exact: true }).click();
    console.log('Chat, mute, camera, screen sharing and device switching verified');
    for (const [width, height, filename] of [[390,844,'mobile-call'], [320,740,'small-phone-call'], [844,390,'landscape-call'], [1366,900,'desktop-call']]) {
      await a.setViewportSize({ width, height }); await geometry(a);
      await a.screenshot({ path: path.join(artifacts, `${filename}.png`) });
    }
    const after = await stats(a);
    for (const kind of ['audio', 'video']) assert.ok(after.find((s) => s.kind === kind)?.bytes > before.find((s) => s.kind === kind)?.bytes, `${kind} packets must increase`);
    await c.goto(`${base}/#${room}`, { waitUntil: 'networkidle' });
    await c.getByLabel('Your name').fill('Third QA'); await c.getByRole('button', { name: 'Join call', exact: true }).click();
    await c.getByRole('alert').filter({ hasText: 'already has two people' }).waitFor();
    assert.equal(await c.locator('.in-call-shell').count(), 0);
    await b.reload({ waitUntil: 'networkidle' });
    await b.getByRole('button', { name: 'Join call', exact: true }).click();
    await live(a); await live(b);
    await a.getByRole('button', { name: 'Leave call', exact: true }).click();
    await a.waitForFunction(() => window.__peers.every((p) => p.connectionState === 'closed'));
    await b.getByText('Your room is ready', { exact: true }).waitFor();
    await a.getByRole('button', { name: 'Join to listen', exact: true }).click();
    await a.locator('.in-call-shell').waitFor();
    await a.waitForFunction(() => window.__peers.some((p) => p.connectionState === 'connected'));
    await live(a);
    console.log('Room capacity, reload and listen-only verified');
    await a.context().setOffline(true);
    await a.getByRole('status').filter({ hasText: /connection lost|server unavailable/i }).waitFor({ timeout: 45000 });
    await a.context().setOffline(false);
    await live(a);
    await b.waitForFunction(() => window.__peers.some((p) => p.connectionState === 'connected'));
    console.log('Offline/online signaling recovery verified');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', target: base, forcedRelay: process.env.TEST_RELAY === '1', checks: ['two-way audio/video packets', 'chat', 'mute/camera', 'screen replacement', 'data saver', 'ICE restart', '320px/390px/landscape/desktop layout', 'third-person rejection', 'reload/rejoin', 'listen-only', 'leave cleanup', 'no browser exceptions'], before, after }, null, 2));
  } finally {
    await Promise.all(contexts.map((c) => c.close())); await browser.close();
    if (web) { web.closeAllConnections(); await new Promise((r) => web.close(r)); }
    if (signaling) await new Promise((r) => signaling.close(r));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
