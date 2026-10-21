# Together Meet

A React and TypeScript client for private, two-person browser meetings. It combines direct WebRTC audio/video transport with Socket.IO signaling, room links, text chat, device-state feedback, and connection diagnostics.

## What it demonstrates

- Browser media capture with clear permission and missing-device states
- Peer-to-peer audio/video negotiation with SDP offers, answers, and ICE candidates
- Configurable STUN/TURN connectivity for real-world networks
- Shareable room URLs and an enforced two-participant room limit
- Text chat, participant presence, measured connection latency, and relay status
- Screen sharing, camera/microphone selection, and data saver
- Audio-only fallback, listen-only joining, and automatic reconnect recovery
- Responsive meeting UI with focused tests around room and device edge cases

## Architecture

```text
Browser A ── Socket.IO signaling ── Signaling server ── Socket.IO signaling ── Browser B
    └──────────────────── WebRTC media connection ────────────────────────────┘
```

The signaling server coordinates room membership and relays negotiation messages. Audio and video flow between browsers through WebRTC. A TURN relay can be configured for networks where a direct connection is unavailable.

## Local development

Requirements:

- Node.js 20 or newer
- A running compatible signaling server
- Camera and microphone access from the browser

```bash
npm ci
npm start
```

By default, the client connects to its own origin. For separate local services, create `.env.local`:

```dotenv
REACT_APP_SIGNALING_URL=http://localhost:3001
REACT_APP_TURN_URLS=turn:turn.example.com:3478
REACT_APP_TURN_USERNAME=replace-me
REACT_APP_TURN_CREDENTIAL=replace-me
```

Keep TURN credentials outside source control.

## Verification

```bash
npm test -- --watchAll=false
npm run build
```

Component tests cover duplicate joining, echo-cancellation constraints, missing-camera fallback, listen-only calls, mobile panel access, full-room cleanup, reconnects, and cancellation during device access.

`npm run test:call` runs Chrome against the production build and the sibling
`webrtc-server` checkout. Set `CHROME_PATH` for a custom Chrome installation.
Set `TEST_URL` to verify a deployment, `TEST_RELAY=1` to require TURN, and
`TEST_TURN_TRANSPORT=tcp` to check TCP-only relay connectivity.

The browser suite checks media packet flow, chat, mute/camera, screen-track
replacement, layout at 320px/390px/landscape/desktop sizes, capacity, refresh,
offline recovery, listen-only, and cleanup. Screenshots go to ignored
`test-artifacts/`. It uses synthetic media: acoustic echo, mobile network quality,
and the operating system screen-picker still need real-device testing.

`node scripts/verify-turn-auth.cjs` verifies that the deployed TURN service
rejects unauthenticated allocations. See `deploy/turn/` for the config-readability
guard and required relay firewall range. The production repair also verified
forced TCP and UDP relay calls through the public meeting domain.

## Container build

```bash
docker compose up --build
```

## Production status

The application is deployed at `https://meet.saeedghofrani.xyz`. It supports two
people per room and does not provide recording, authentication, end-to-end identity
verification, or multi-party conferencing. Anyone with a room link can join if a
slot is available. TURN credentials configured in the client are visible to
browsers and must not be reused for another service.

## Android ringing links

When the updated signaling server reports incoming calls enabled, the prejoin
screen offers **Create a private ringing link**. Share the generated URL; the
recipient opens it in the Android app and explicitly enables ringing. The caller
uses **Ring recipient**, then joins the meeting. Call status reports answer,
decline, cancellation, or expiry; push acceptance is not proof a device rang.

The Android app, Firebase configuration, and `/api/call-links` proxy routing must
be deployed together. Ordinary room invitations still work with push disabled.
Private links stay in their assigned room and failed lookups block joining to
avoid sending a recipient into a random room. Anyone holding a private link can
ring it, so share it privately. Android source/setup is at
[webrtc-android](https://github.com/saeedghofrani/webrtc-android) (private repository).

`npm run test:ringing` checks the production web bundle against a local server
with a fake push transport: link creation, recipient opt-in, call delivery,
authenticated answer, caller status, and mobile layout. It does not verify FCM or
Android ringing. Normal call verification remains `npm run test:call`.

## Related repository

- [WebRTC signaling server](https://github.com/saeedghofrani/webrtc-server)
