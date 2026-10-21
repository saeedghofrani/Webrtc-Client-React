// Local integration only: fake push transport, real API and production web bundle.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('../../webrtc-server/node_modules/express');
const { chromium } = require('playwright-core');
const { createSignalingServer } = require('../../webrtc-server');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-ringing-browser-'));
  const pushes = [];
  const signaling = createSignalingServer({ callLinks: { enabled: true, file: path.join(directory, 'registry.json'), push: async (token, data) => { pushes.push(data); } } });
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));
  const port = signaling.server.address().port;
  const app = express();
  app.use('/api', (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port, path: req.originalUrl, method: req.method, headers: req.headers }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    req.pipe(upstream); upstream.on('error', () => { res.writeHead(502); res.end(); });
  });
  app.use(express.static(path.join(__dirname, '../build')));
  const web = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${web.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Create a private ringing link' }).click();
    await page.getByRole('button', { name: 'Ring recipient' }).waitFor();
    const token = new URL(page.url()).searchParams.get('call');
    assert.match(token, /^[a-zA-Z0-9_-]{43}$/);
    await page.getByLabel('Your name').fill('Saeed');
    await page.getByRole('button', { name: 'Ring recipient' }).click();
    await page.getByRole('alert').filter({ hasText: /recipient must enable/ }).waitFor();
    const registration = await fetch(`${origin}/api/call-links/${token}/subscriptions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pushToken: 'local-fake-android-device-token' }) }).then((r) => r.json());
    await page.getByRole('button', { name: 'Ring recipient' }).click();
    await page.getByText('Call alert sent. Waiting for an answer…').waitFor();
    assert.equal(pushes[0].type, 'incoming-call');
    const answer = await fetch(`${origin}/api/call-links/${token}/calls/${pushes[0].callId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.credential}` }, body: '{}' });
    assert.equal(answer.status, 200);
    await page.getByText('Call answered.').waitFor({ timeout: 6000 });
    assert.equal(pushes.at(-1).type, 'call-ended');
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(__dirname, '../test-artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../test-artifacts/private-ringing-link-mobile.png'), fullPage: true });
    console.log('PASS: private-link creation, recipient opt-in, fake push delivery, authenticated answer, caller status and mobile UI. Actual FCM/device ringing is not covered.');
  } finally {
    await browser.close(); web.closeAllConnections();
    await new Promise((resolve) => web.close(resolve));
    await new Promise((resolve) => signaling.io.close(resolve));
    fs.rmSync(directory, { recursive: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
