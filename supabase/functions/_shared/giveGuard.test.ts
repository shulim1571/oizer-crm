import { describe, expect, it } from 'vitest';
import { botCheckDecision, gateCheck, sameSecret } from './giveGuard';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('give function guards', () => {
  it('refuse a payment when no Turnstile secret is set, sandbox or not', () => {
    expect(botCheckDecision(null, 'token')).toBe('not_set_up');
    expect(botCheckDecision('', 'token')).toBe('not_set_up');
    expect(botCheckDecision(undefined, undefined)).toBe('not_set_up');
    expect(botCheckDecision('0x4AAA-secret', null)).toBe('no_token');
    expect(botCheckDecision('0x4AAA-secret', 'token')).toBe('verify');
  });

  it('only accept requests from the gate once its secret is set, and take the donor IP from it', () => {
    const viaGate = headers({ 'x-give-gate': 's3cret', 'x-oizer-client-ip': '1.2.3.4', 'cf-connecting-ip': '104.0.0.1' });
    expect(gateCheck('s3cret', viaGate)).toEqual({ ok: true, ip: '1.2.3.4' });
    expect(gateCheck('s3cret', headers({ 'cf-connecting-ip': '9.9.9.9' }))).toEqual({ ok: false });
    expect(gateCheck('s3cret', headers({ 'x-give-gate': 's3creT', 'x-oizer-client-ip': '1.2.3.4' }))).toEqual({ ok: false });
    // A direct caller can't pick its own IP without the secret.
    expect(gateCheck('s3cret', headers({ 'x-oizer-client-ip': '1.2.3.4' }))).toEqual({ ok: false });
    // Before the secret is set, nothing changes.
    expect(gateCheck(null, headers({ 'cf-connecting-ip': '9.9.9.9', 'x-oizer-client-ip': '1.2.3.4' }))).toEqual({ ok: true, ip: '9.9.9.9' });
  });

  it('compare secrets fully', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('abc', '')).toBe(false);
    expect(sameSecret('abc', null)).toBe(false);
  });
});
