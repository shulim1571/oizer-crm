// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from './Inbox';

// Moshe Henig, 2026-11-15: a voice note in the chat is not sent when recording stops. It stops into a preview, and
// goes out only when Send is tapped; it can be discarded instead.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeRecorder {
  static isTypeSupported = (m: string) => m === 'audio/webm';
  state = 'inactive'; mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) }); this.onstop?.(); }
}
const trackStop = vi.fn();
const mounted: { unmount(): void }[] = [];
let now = 1_000_000;

function mount(onSend = vi.fn(async (_v: { mime: string; seconds: number }) => true)) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Recorder disabled={false} onSend={onSend} onError={() => {}} />));
  mounted.push(root);
  return { host, onSend };
}
const btn = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => (b.textContent + ' ' + (b.getAttribute('aria-label') ?? '')).includes(text)) as HTMLButtonElement;
async function record(host: HTMLElement, seconds: number) {
  await act(async () => { btn(host, 'Record a voice message').click(); });
  now += seconds * 1000;
  await act(async () => { btn(host, 'Stop recording').click(); });
}

describe('voice notes in the chat', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    (globalThis as any).MediaRecorder = FakeRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }) } });
    (URL as any).createObjectURL = () => 'blob:voice'; (URL as any).revokeObjectURL = () => {};
  });
  afterEach(() => { act(() => { while (mounted.length) mounted.pop()!.unmount(); }); document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('stops into a preview and sends nothing until Send is tapped', async () => {
    const { host, onSend } = mount();
    await record(host, 5);
    expect(onSend).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();                       // the microphone is off while it waits
    expect(host.querySelector('.voice-ready audio')).toBeTruthy();
    expect(host.textContent).toContain('0:05');
    await act(async () => { btn(host, 'Send voice message').click(); });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ mime: 'audio/webm', seconds: 5 });
    await vi.waitFor(() => expect(host.querySelector('.voice-ready')).toBeNull());
  });

  it('can be discarded instead, and nothing is sent', async () => {
    const { host, onSend } = mount();
    await record(host, 3);
    await act(async () => { btn(host, 'Discard').click(); });
    expect(host.querySelector('.voice-ready')).toBeNull();
    expect(btn(host, 'Record a voice message')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the note to try again if sending fails', async () => {
    const onSend = vi.fn(async (_v: { mime: string; seconds: number }) => false);
    const { host } = mount(onSend);
    await record(host, 4);
    await act(async () => { btn(host, 'Send voice message').click(); });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(host.querySelector('.voice-ready')).toBeTruthy();
  });

  it('discarding while recording keeps nothing', async () => {
    const { host, onSend } = mount();
    await act(async () => { btn(host, 'Record a voice message').click(); });
    now += 4000;
    await act(async () => { btn(host, 'Discard').click(); });
    expect(host.querySelector('.voice-ready')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('stops by itself at two minutes, into the preview, not sent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { host, onSend } = mount();
      await act(async () => { btn(host, 'Record a voice message').click(); });
      now += 121_000;
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(host.querySelector('.voice-ready')).toBeTruthy();
      expect(host.textContent).toContain('2:00');
      expect(onSend).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
