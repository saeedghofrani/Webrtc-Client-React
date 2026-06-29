import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WebRTC from './WebRTC';

type Handler = (...args: any[]) => void;

class FakeSocket {
  handlers: Record<string, Handler[]> = {};
  emitted: Array<{ event: string; payload: any }> = [];
  id = 'local-socket';

  on(event: string, handler: Handler) {
    this.handlers[event] = [...(this.handlers[event] || []), handler];
    return this;
  }

  emit(event: string, payload: any) {
    this.emitted.push({ event, payload });
    return this;
  }

  disconnect() {}

  dispatch(event: string, payload?: any) {
    for (const handler of this.handlers[event] || []) {
      handler(payload);
    }
  }
}

const mockSocket = new FakeSocket();
const mockIo = jest.fn<FakeSocket, [string, any]>(() => mockSocket);

jest.mock('socket.io-client', () => ({
  io: (endpoint: string, options: any) => mockIo(endpoint, options),
}));

const createOffer = jest.fn<Promise<RTCSessionDescriptionInit>, []>(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
const createAnswer = jest.fn<Promise<RTCSessionDescriptionInit>, []>(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
const setLocalDescription = jest.fn<Promise<void>, [RTCSessionDescriptionInit]>(async () => undefined);
const setRemoteDescription = jest.fn<Promise<void>, [RTCSessionDescriptionInit]>(async () => undefined);
const addIceCandidate = jest.fn<Promise<void>, [RTCIceCandidateInit]>(async () => undefined);
const addTrack = jest.fn();
const close = jest.fn();
const stopTrack = jest.fn();

class FakeRTCPeerConnection {
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  onicecandidateerror: ((event: Event) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';

  addTrack = addTrack;
  createOffer = createOffer;
  createAnswer = createAnswer;
  addIceCandidate = addIceCandidate;
  close = close;

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    await setLocalDescription(description);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    await setRemoteDescription(description);
  }
}

const stream = {
  getTracks: () => [{ enabled: true, stop: stopTrack }, { enabled: true, stop: stopTrack }],
  getAudioTracks: () => [{ enabled: true }],
  getVideoTracks: () => [{ enabled: true }],
} as unknown as MediaStream;

beforeEach(() => {
  mockSocket.handlers = {};
  mockSocket.emitted = [];
  jest.clearAllMocks();
  mockIo.mockImplementation(() => mockSocket);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  window.location.hash = '';
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => stream) },
  });
  window.history.replaceState = jest.fn();
  window.RTCPeerConnection = jest.fn(() => new FakeRTCPeerConnection()) as any;
});

test('joins a room without creating an untargeted peer connection', async () => {
  render(<WebRTC />);

  fireEvent.click(screen.getByRole('button', { name: /start \/ join room/i }));

  await waitFor(() => expect(mockSocket.emitted.some((item) => item.event === 'join-room')).toBe(true));
  expect(mockIo).toHaveBeenCalledWith(window.location.origin, { transports: ['polling'], upgrade: false });
  expect(window.RTCPeerConnection).not.toHaveBeenCalled;
});

test('only connects to the first remote participant in a two-person room', async () => {
  render(<WebRTC />);

  fireEvent.click(screen.getByRole('button', { name: /start \/ join room/i }));
  await waitFor(() => expect(mockSocket.emitted.some((item) => item.event === 'join-room')).toBe(true));

  await act(async () => {
    mockSocket.dispatch('peer-ready', { peerId: 'peer-a', name: 'Ava' });
    mockSocket.dispatch('peer-ready', { peerId: 'peer-b', name: 'Ben' });
  });

  await waitFor(() => expect(createOffer).toHaveBeenCalledTimes(1));
  expect(window.RTCPeerConnection).toHaveBeenCalledTimes(1);
  expect(mockSocket.emitted.filter((item) => item.event === 'offer').map((item) => item.payload.to)).toEqual([
    'peer-a',
  ]);
});

test('requests mobile-friendly media with echo cancellation', async () => {
  const getUserMedia = jest.fn(async () => stream);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });

  render(<WebRTC />);

  fireEvent.click(screen.getByRole('button', { name: /start \/ join room/i }));

  await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  expect(getUserMedia).toHaveBeenCalledWith({
    video: {
      width: { ideal: 640, max: 960 },
      height: { ideal: 360, max: 540 },
      frameRate: { ideal: 24, max: 24 },
      facingMode: 'user',
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
});

test('shows room full instead of joining as a third participant', async () => {
  render(<WebRTC />);

  fireEvent.click(screen.getByRole('button', { name: /start \/ join room/i }));
  await waitFor(() => expect(mockSocket.emitted.some((item) => item.event === 'join-room')).toBe(true));

  act(() => {
    mockSocket.dispatch('room-full', { roomId: 'ABC123' });
  });

  expect(screen.getByText('This room already has two people.')).toBeInTheDocument();
  expect(screen.queryByText('People')).not.toBeInTheDocument();
});

test('does not join when camera or microphone devices are unavailable', async () => {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: jest.fn(() => Promise.reject(new DOMException('No devices', 'NotFoundError'))),
    },
  });

  render(<WebRTC />);

  fireEvent.click(screen.getByRole('button', { name: /start \/ join room/i }));

  expect(await screen.findByText('No working camera or microphone was found on this device.')).toBeInTheDocument();
  expect(mockSocket.emitted.some((item) => item.event === 'join-room')).toBe(false);
});
