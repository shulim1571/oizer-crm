// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Sign in with Google (Moshe, approved by Shulim, 2026-11-16): shown only when Google is on in Supabase Auth; no
// Google secret in the code; the two-step code check still applies after Google.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const oauth = vi.fn(async (_: unknown) => ({ error: null }));
vi.mock('../lib/supabase', () => ({
  signInWithPassword: async () => ({ error: null }),
  supabase: { auth: { signInWithOAuth: (a: unknown) => oauth(a) } },
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ org: null }) }));
vi.mock('../components/Layout', () => ({ OrgLogo: () => null, ProductLockup: () => null, PRODUCT_NAME: 'FundBase' }));
vi.mock('../components/PoweredBy', () => ({ PoweredBy: () => null }));
import Login from './Login';

async function render(googleOn: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ external: { google: googleOn, email: true } }), { status: 200 })));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Login />));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { host, root };
}

describe('Sign in with Google', () => {
  it('stays hidden until Google is turned on in Supabase Auth', async () => {
    const { host, root } = await render(false);
    expect(host.textContent).not.toContain('Sign in with Google');
    expect(host.textContent).toContain('Sign in');
    act(() => root.unmount());
  });

  it('starts Google sign-in when on, and says a code is still asked for', async () => {
    const { host, root } = await render(true);
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Sign in with Google'))!;
    expect(btn).toBeTruthy();
    expect(host.textContent).toContain("you'll still be asked for a code after Google");
    await act(async () => { btn.click(); });
    expect(oauth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
    act(() => root.unmount());
  });

  it('keeps Google keys out of the code, and the two-step check applies to every session', () => {
    const login = readFileSync('src/pages/Login.tsx', 'utf8');
    expect(login).not.toMatch(/apps\.googleusercontent\.com|GOCSPX|client_secret/i);
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toContain('const needsCode = !mfa.loading && mfa.enrolled && !mfa.verified && !codeSkipped;');
  });
});
