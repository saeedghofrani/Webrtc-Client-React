import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WebRTC from './WebRTC';

class FakeSocket {
  connected = false;
  id = 'local';
  handlers: Record<string, (...args: any[]) => void> = {};
  emitted: Array<{ event: string; payload: any }> = [];
  on(event: string, handler: (...args: any[]) => void) { this.handlers[event] = handler; return this; }
  emit(event: string, payload?: any) { this.emitted.push({ event, payload }); }
  connect() { this.connected = true; this.handlers.connect?.(); }
  disconnect() { this.connected = false; }
  removeAllListeners() { this.handlers = {}; }
  dispatch(event: string, payload?: any) { this.handlers[event]?.(payload); }
}
const mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
let tracks: any[];
const makeStream = (items: any[]) => ({
  getTracks: () => items, getAudioTracks: () => items.filter((t) => t.kind === 'audio'),
  getVideoTracks: () => items.filter((t) => t.kind === 'video'),
});
beforeEach(() => {
  tracks = ['audio', 'video'].map((kind) => ({ kind, enabled: true, stop: jest.fn(), getSettings: () => ({}) }));
  mockSocket.handlers = {}; mockSocket.emitted = []; mockSocket.connected = false;
  window.MediaStream = jest.fn((items = []) => makeStream(items)) as any;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: jest.fn(async () => makeStream(tracks)), enumerateDevices: jest.fn(async () => []),
  } });
  window.history.replaceState(null, '', '#TEST');
  localStorage.clear();
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
});
function start() {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Saeed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
}
async function accepted() {
  await waitFor(() => expect(mockSocket.emitted.some((e) => e.event === 'join-room')).toBe(true));
  act(() => mockSocket.dispatch('room-joined', { users: [{ id: 'local', name: 'Saeed' }] }));
}
test('joins once, uses echo cancellation and releases tracks on leave', async () => {
  render(<WebRTC />); start();
  fireEvent.click(screen.getByRole('button', { name: 'Connecting...' }));
  await accepted();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
  expect(tracks[0].enabled).toBe(false);
  expect(tracks[1].enabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Leave call' }));
  tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  expect((screen.getByRole('button', { name: 'Join call' }))).toBeInTheDocument();
});
test('falls back to an audio call when camera is missing', async () => {
  (navigator.mediaDevices.getUserMedia as jest.Mock).mockRejectedValueOnce(new DOMException('Camera missing', 'NotFoundError')).mockResolvedValueOnce(makeStream([tracks[0]]));
  render(<WebRTC />); start(); await accepted();
  expect(screen.getByText('Camera unavailable. Joined with audio.')).toBeInTheDocument();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
});
test('listen-only works without local devices and mobile panels remain accessible', async () => {
  render(<WebRTC />);
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Guest' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join to listen' })); await accepted();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(mockSocket.emitted.some((e) => e.event === 'chat-message' && e.payload.text === 'Hello')).toBe(true);
});
test('room full stops devices and resets the join button', async () => {
  render(<WebRTC />); start();
  await waitFor(() => expect(mockSocket.emitted.some((e) => e.event === 'join-room')).toBe(true));
  act(() => mockSocket.dispatch('room-full'));
  tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  expect(screen.getByRole('alert')).toHaveTextContent('already has two people');
  expect(screen.getByRole('button', { name: 'Join call' })).toBeEnabled();
});
test('rejoins signaling after a disconnect', async () => {
  render(<WebRTC />); start(); await accepted();
  act(() => mockSocket.dispatch('connect'));
  expect(mockSocket.emitted.filter((e) => e.event === 'join-room')).toHaveLength(2);
});
test('cancel during permission request stops late media and never joins', async () => {
  let resolve: (value: any) => void = () => {};
  (navigator.mediaDevices.getUserMedia as jest.Mock).mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<WebRTC />); start();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => resolve(makeStream(tracks)));
  tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  expect(mockSocket.emitted.some((e) => e.event === 'join-room')).toBe(false);
});
