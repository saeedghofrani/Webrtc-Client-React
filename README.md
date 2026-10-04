# WebRTC Meeting Client

A React and TypeScript client for private, two-person browser meetings. It combines direct WebRTC audio/video transport with Socket.IO signaling, room links, text chat, device-state feedback, and connection diagnostics.

## What it demonstrates

- Browser media capture with clear permission and missing-device states
- Peer-to-peer audio/video negotiation with SDP offers, answers, and ICE candidates
- Configurable STUN/TURN connectivity for real-world networks
- Shareable room URLs and an enforced two-participant room limit
- Text chat, participant presence, connection status, and bounded diagnostics
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

The focused component tests cover joining without an untargeted peer, accepting only one remote participant, clearing media when a room is full, and handling unavailable camera or microphone devices.

## Container build

```bash
docker compose up --build
```

## Production status

The application has been deployed as a personal demonstration at `meet.saeedghofrani.xyz`. Public access is temporarily pending the documented DNS and certificate cutover. The project is a demonstration system and does not provide meeting recording, authentication, end-to-end identity verification, or multi-party conferencing.

## Related repository

- [WebRTC signaling server](https://github.com/saeedghofrani/webrtc-server)
