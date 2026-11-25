// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Donor address suggestions (Shulim, 2026-11-25): wait about 300 ms after typing, need 3+ characters, fill the box on
// a pick, and don't ask again for a picked address or for text already asked about. Sample data only.
const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } }, requestOrgId: () => 'org-1' }));
import AddressSuggest, { resetAddressSuggest } from './AddressSuggest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SUGG = { street: '123 Sample St', city: 'Brooklyn', state: 'NY', zip: '11219', one_line: '123 Sample St, Brooklyn NY 11219', two_lines: '123 Sample St\nBrooklyn NY 11219' };

function Harness({ start = '' }: { start?: string }) {
  const [v, setV] = useState(start);
  return <><AddressSuggest value={v} onChange={setV} /><output>{v}</output></>;
}
let host: HTMLDivElement;
const input = () => host.querySelector('input')!;
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input(), text); input().dispatchEvent(new Event('input', { bubbles: true })); });
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('donor address suggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers(); resetAddressSuggest(); invoke.mockReset();
    invoke.mockResolvedValue({ data: { suggestions: [SUGG] }, error: null });
    host = document.createElement('div'); document.body.appendChild(host);
  });
  afterEach(() => { vi.useRealTimers(); host.remove(); });

  it('asks only after 3 characters and about 300 ms without typing', async () => {
    await act(async () => createRoot(host).render(<Harness />));
    await type('12');
    await wait(400);
    expect(invoke).not.toHaveBeenCalled();
    await type('123');
    await wait(200);
    await type('123 S');
    await wait(200);
    expect(invoke).not.toHaveBeenCalled();   // still typing
    await wait(150);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('address-suggest', { body: { org: 'org-1', query: '123 S' } });
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('fills street, city, state and ZIP on a pick, and doesn\'t look the picked address up again', async () => {
    await act(async () => createRoot(host).render(<Harness />));
    await type('123 Sam');
    await wait(350);
    await act(async () => { host.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(host.querySelector('output')!.textContent).toBe('123 Sample St, Brooklyn NY 11219');
    await wait(500);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('picks with the keyboard, and reuses an answer it already has', async () => {
    await act(async () => createRoot(host).render(<Harness />));
    await type('123 Sam');
    await wait(350);
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(host.querySelector('output')!.textContent).toBe('123 Sample St, Brooklyn NY 11219');
    await type('123 Sam');
    await wait(350);
    expect(invoke).toHaveBeenCalledTimes(1);   // same text: answered from this visit's memory
  });

  it('doesn\'t look up a saved address that was only loaded, and shows a limit message', async () => {
    await act(async () => createRoot(host).render(<Harness start="1 Saved Address Rd, Monsey NY 10952" />));
    await wait(500);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ data: null, error: { context: new Response(JSON.stringify({ error: 'Address suggestions have reached today\'s limit; type the address in full', suggestions: [] }), { status: 429 }) } });
    await type('99 Sample');
    await wait(350);
    expect(host.textContent).toContain('reached today\'s limit');
  });

  it('is the donor address\'s Street box, in separate address boxes (not bulk edits); Check with USPS is gone', () => {
    expect(readFileSync('src/lib/schemas.ts', 'utf8')).toContain("{ name: 'address', label: 'Address', type: 'usaddress', addressSuggest: true,");
    expect(readFileSync('src/components/RecordForm.tsx', 'utf8')).toContain("if (f.type === 'usaddress' && !f.readOnly && !p.onBulk) {");
    for (const f of ['src/components/RecordForm.tsx', 'src/components/AddressEditor.tsx', 'src/pages/Organization.tsx', 'src/lib/schemas.ts', 'src/styles.css']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/AddressCheck|uspsCheck|usps-address|Check with USPS|UspsKeys/);
    }
  });

  it('hands back the picked address in parts when the form wants separate boxes', async () => {
    const picked: unknown[] = [];
    function Parts() {
      const [v, setV] = useState('');
      return <AddressSuggest value={v} onChange={setV} onPick={s => picked.push(s)} />;
    }
    await act(async () => createRoot(host).render(<Parts />));
    await type('123 Sam');
    await wait(350);
    await act(async () => { host.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(picked).toEqual([SUGG]);
  });
});
