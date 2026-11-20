import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callTwiml, MFA_FROM, smsBody } from './phoneCode';

// Two-step verification by text or call (Shulim, 2026-11-11).
describe('phone codes as sent', () => {
  it('come only from Oizer’s Twilio number', () => {
    expect(MFA_FROM).toBe('+18456134272');
  });

  it('text the code with its expiry', () => {
    expect(smsBody('048213')).toBe("Your Donor Base code is 048213. It expires in 10 minutes. Don't share it with anyone.");
  });

  it('read the code slowly, digit by digit, twice, in valid TwiML', () => {
    const x = callTwiml('048213');
    expect(x.match(/0, 4, 8, 2, 1, 3\./g)).toHaveLength(2);
    expect(x.startsWith('<?xml')).toBe(true);
    expect(x).toMatch(/<Response>[^]*<\/Response>$/);
    expect(callTwiml('<1>')).not.toContain('<1>');
  });
});

describe('the phone-code function', () => {
  const fn = readFileSync('supabase/functions/phone-code/index.ts', 'utf8');
  it('reads Twilio credentials only from secrets, and never logs', () => {
    expect(fn).toContain("Deno.env.get('TWILIO_ACCOUNT_SID')");
    expect(fn).toContain("Deno.env.get('TWILIO_AUTH_TOKEN')");
    expect(fn).not.toMatch(/console\.(log|info|debug|warn|error)/);
    expect(fn).not.toMatch(/AC[0-9a-f]{32}/);
  });

  it('checks the person first, lets the database make the code, and never returns the code to the browser', () => {
    expect(fn.indexOf("rpc('mfa_phone_start'")).toBeLessThan(fn.indexOf("rpc('mfa_phone_issue'"));
    const replies = [...fn.matchAll(/reply\(\{[^}]*\}/g)].map(m => m[0]);
    expect(replies.some(r => /issued\.code|code:/.test(r))).toBe(false);
    expect(fn).toContain('return reply({ challenge_id: challenge.challenge_id, phone_masked: challenge.phone_masked, channel: issued.channel });');
  });
});

describe('phone codes in the app', () => {
  it('offer text or call with resend, at sign-in, on Reconciliation and under Account security', () => {
    const sec = readFileSync('src/pages/Security.tsx', 'utf8');
    expect(sec).toMatch(/Text me<\/label>[^]*Call me<\/label>[^]*Send a new code/);
    expect(sec).toContain('<PhonePrompt purpose="enroll"');
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<VerifySession mfa={mfa}');
    expect(readFileSync('src/pages/Reconciliation.tsx', 'utf8')).toContain('<VerifySession mfa={mfa}');
    // The browser only asks; the database records the verification for this session.
    expect(readFileSync('src/lib/mfa.ts', 'utf8')).toContain("supabase.rpc('mfa_phone_verify'");
    expect(readFileSync('src/lib/mfa.ts', 'utf8')).toContain("aal?.currentLevel === 'aal2' || !!p?.session_verified");
  });
});
