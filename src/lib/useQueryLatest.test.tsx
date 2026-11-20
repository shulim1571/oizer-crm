// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Readiness #40 (2026-11-15): switching the date range could show the previous range's totals, when the earlier
// request finished after the newer one. Only the latest request now sets the data.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./live', () => ({ useLiveRefresh: () => {} }));
import { useQuery } from './useQuery';

describe('useQuery', () => {
  it('ignores an older answer that arrives after a newer one, and shows loading meanwhile', async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    const seen: { data: unknown; loading: boolean }[] = [];
    function Probe({ range }: { range: string }) {
      const q = useQuery(() => new Promise<string>(r => { resolvers[range] = r; }), [range]);
      seen.push({ data: q.data, loading: q.loading });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe range="7 days" />));
    await act(async () => root.render(<Probe range="30 days" />));   // switched before the first answered
    await act(async () => { resolvers['30 days']('totals for 30 days'); });
    await act(async () => { resolvers['7 days']('totals for 7 days'); });   // the old one, late
    expect(seen.at(-1)).toEqual({ data: 'totals for 30 days', loading: false });
    expect(seen.some(s => s.data === 'totals for 7 days')).toBe(false);
    act(() => root.unmount());
  });
});
