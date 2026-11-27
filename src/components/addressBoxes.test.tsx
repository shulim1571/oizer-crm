// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// The donor address in separate boxes, filled by a picked suggestion (Shulim, 2026-11-25). Sample data only.
const invoke = vi.fn(async () => ({ data: { suggestions: [{ street: '123 Sample St', city: 'Brooklyn', state: 'NY', zip: '11219', one_line: '123 Sample St, Brooklyn NY 11219', two_lines: '123 Sample St\nBrooklyn NY 11219' }] }, error: null }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...(a as [])) } }, requestOrgId: () => 'org-1' }));
import AddressBoxes from './AddressBoxes';
import { parseStates } from './AddressRegionSetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Harness({ start }: { start: string }) {
  const [v, setV] = useState(start);
  return <><AddressBoxes value={v} onChange={setV} /><output>{v}</output></>;
}
const boxes = (host: HTMLElement) => [...host.querySelectorAll('input')].map(i => i.value);

describe('donor address boxes', () => {
  it('open a saved address in street, apt, city, state and ZIP', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    await act(async () => createRoot(host).render(<Harness start={'45 Example Ave Apt 2\nMonsey NY 10952'} />));
    expect(boxes(host)).toEqual(['45 Example Ave', 'Apt 2', 'Monsey', 'NY', '10952']);
  });

  it('fill street, city, state and ZIP from a picked suggestion, kept as the one address field', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div'); document.body.appendChild(host);
    await act(async () => createRoot(host).render(<Harness start="" />));
    const street = host.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(street, '123 Sam'); street.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { host.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(boxes(host)).toEqual(['123 Sample St', '', 'Brooklyn', 'NY', '11219']);
    expect(host.querySelector('output')!.textContent).toBe('123 Sample St\nBrooklyn NY 11219');
    vi.useRealTimers();
  });

  it('reads the region setting\'s states', () => {
    expect(parseStates('ny, nj ct')).toEqual({ states: ['NY', 'NJ', 'CT'], unknown: [] });
    expect(parseStates('NY, New York')).toEqual({ states: ['NY'], unknown: ['NEW', 'YORK'] });
  });
});
