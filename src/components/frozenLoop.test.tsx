// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// 2026-11-18: the Task Sheet crashed (React error #185, an update loop). Its rows are a new array on every render,
// and the frozen-column measuring set a fresh [] after each render when nothing was frozen. Lists like it must render
// and settle, with or without frozen columns.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let views: unknown[] = [];
vi.mock('../lib/supabase', () => {
  const chain: any = { select: () => chain, eq: () => chain, order: async () => ({ data: views }) };
  return { supabase: { from: () => chain }, logActivity: () => {}, fetchAll: async () => [] };
});
vi.mock('../lib/auth', () => ({ useAuth: () => ({ profile: { user_id: 'u1' }, isAdmin: true, permissions: [] }) }));
vi.mock('./Layout', () => ({ useSearch: () => ({ q: '', setQ: () => {} }) }));
import DataTable from './DataTable';

const columns = [
  { key: 'name', label: 'Donor' },
  { key: 'amount', label: 'Amount' },
  { key: 'campaign', label: 'Campaign' },
];

/** Like the Task Sheet: rows rebuilt on every render, and the page re-renders a few times on its own. */
function Page() {
  const [tick, setTick] = useState(0);
  useEffect(() => { if (tick < 5) setTick(t => t + 1); }, [tick]);
  const rows = [1, 2, 3].map(i => ({ id: String(i), name: `Donor ${i}`, amount: i * 10, campaign: `Campaign ${i}` }));
  return <DataTable title="Task Sheet" rows={rows} columns={columns} onOpen={() => {}} />;
}

async function renderPage() {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter><Page /></MemoryRouter>));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const text = host.textContent ?? '';
  act(() => root.unmount());
  spy.mockRestore();
  return { text, errors };
}

describe('lists with rows rebuilt on every render', () => {
  it('settle without an update loop when no column is frozen (the Task Sheet)', async () => {
    views = [];
    const { text, errors } = await renderPage();
    expect(text).toContain('Donor 3');
    expect(errors.map(String).join('\n')).not.toMatch(/Maximum update depth|#185/);
  });

  it('settle without an update loop with two frozen columns', async () => {
    views = [{ id: 'v1', name: 'My default', is_default: true, config: { freeze: 2 } }];
    const { text, errors } = await renderPage();
    expect(text).toContain('Donor 3');
    expect(errors.map(String).join('\n')).not.toMatch(/Maximum update depth|#185/);
  });
});
