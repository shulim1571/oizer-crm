import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IDLE_LIMIT_MS, MAX_SESSION_HOURS, idleTooLong } from './idle';

// Security gaps closed before the Plaid production application (Shulim, 2026-11-11).
describe('session limits', () => {
  it('signs out after 30 idle minutes; the server also caps sessions at 12 hours', () => {
    expect(IDLE_LIMIT_MS).toBe(30 * 60 * 1000);
    expect(MAX_SESSION_HOURS).toBe(12);
    const now = Date.now();
    expect(idleTooLong(now - 29 * 60 * 1000, now)).toBe(false);
    expect(idleTooLong(now - 31 * 60 * 1000, now)).toBe(true);
    expect(idleTooLong(null, now)).toBe(false);
    expect(readFileSync('src/lib/auth.tsx', 'utf8')).toContain('return watchIdle(() => {');
  });
});

describe('passwords', () => {
  it('needs 12 characters for a new password, and doesn’t block existing shorter ones at sign-in', () => {
    const login = readFileSync('src/pages/Login.tsx', 'utf8');
    expect(login).toContain('export const MIN_PASSWORD = 12;');
    expect(login).toContain("minLength={mode === 'signup' ? MIN_PASSWORD : undefined}");
    expect(login).not.toMatch(/minLength=\{8\}/);
  });
});

describe('two-step verification screens', () => {
  it('lets anyone set it up from Account security, with a QR code and a code to confirm', () => {
    const page = readFileSync('src/pages/Security.tsx', 'utf8');
    expect(page).toContain("supabase.auth.mfa.enroll({ factorType: 'totp'");
    expect(page).toContain('<CodePrompt factorId={enrolling.id}');
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="security" element={<AccountSecurityPage />} />');
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain('to="/security"');
  });

  it('asks for the code at sign-in, with Not now so nobody is locked out', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(/mfa\.enrolled && !mfa\.verified && !codeSkipped[^]*onSkip=/);
  });

  it('keeps Reconciliation (and its Plaid panel) behind a verified session', () => {
    const recon = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
    expect(recon).toMatch(/if \(!mfa\.verified\) \{[^]*Two-step verification needed[^]*return <ReconciliationScreen \/>/);
  });
});
