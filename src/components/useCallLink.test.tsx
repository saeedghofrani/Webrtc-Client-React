import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallLink } from './useCallLink';

const token = 'a'.repeat(43);
const mockFetch = jest.fn();
const response = (body: object, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  global.fetch = mockFetch;
  mockFetch.mockReset();
});
test('resolves a private link before allowing its meeting room to be used', async () => {
  window.history.replaceState(null, '', `/?call=${token}`);
  let finish: (value: any) => void = () => {};
  mockFetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const setRoom = jest.fn();
  const { result } = renderHook(() => useCallLink(setRoom));
  expect(result.current.loading).toBe(true);
  await act(async () => finish({ ok: true, json: async () => ({ room: 'PRIVATE', enabled: true }) }));
  expect(setRoom).toHaveBeenCalledWith('PRIVATE');
  expect(result.current.loading).toBe(false);
});
test('failed private-link resolution stays locked', async () => {
  window.history.replaceState(null, '', `/?call=${token}`);
  mockFetch.mockImplementation(() => response({ error: 'Link unavailable' }, 404));
  const setRoom = jest.fn();
  const { result } = renderHook(() => useCallLink(setRoom));
  await waitFor(() => expect(result.current.error).toBe('Link unavailable'));
  expect(result.current.loading).toBe(true);
  expect(setRoom).not.toHaveBeenCalled();
});
test('creates a persistent invitation and uses its server-assigned room', async () => {
  mockFetch.mockImplementation((url: string, options: any) => response(options.method === 'POST' ? { token, room: 'CREATED' } : url.endsWith('/config') ? { enabled: true } : { enabled: true, room: 'CREATED' }));
  const setRoom = jest.fn();
  const { result } = renderHook(() => useCallLink(setRoom));
  await waitFor(() => expect(result.current.enabled).toBe(true));
  await act(async () => { await result.current.create(); });
  expect(new URLSearchParams(window.location.search).get('call')).toBe(token);
  expect(setRoom).toHaveBeenCalledWith('CREATED');
});
test('rings and cancels through the private link without claiming confirmed device delivery', async () => {
  window.history.replaceState(null, '', `/?call=${token}`);
  mockFetch.mockImplementation((url: string) => response(url.endsWith('/cancel') ? { status: 'cancelled' } : url.endsWith('/calls') ? { callId: 'call-1' } : { enabled: true, room: 'PRIVATE' }));
  const setRoom = jest.fn();
  const { result } = renderHook(() => useCallLink(setRoom));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.ring('Saeed'); });
  expect(result.current.activeCall).toBe('call-1');
  expect(result.current.progress).toContain('alert sent');
  await act(async () => { await result.current.cancel(); });
  expect(result.current.activeCall).toBe('');
  expect(result.current.progress).toBe('Call cancelled.');
});
