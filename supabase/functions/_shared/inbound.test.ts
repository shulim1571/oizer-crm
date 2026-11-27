import { describe, expect, it } from 'vitest';
import { authenticity, inboxRecipients, isForwardingConfirmation, maskCards, parseDkim, safeName, tokenMatches } from './inbound';

// The organization inbox's receiving checks (2026-11-19).
describe('inbound mail checks', () => {
  it('accepts only the configured secret (or the next one while changing it)', () => {
    expect(tokenMatches('s3cret-token', 's3cret-token')).toBe(true);
    expect(tokenMatches('next-token', 's3cret-token', 'next-token')).toBe(true);
    expect(tokenMatches('s3cret-tokeX', 's3cret-token')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('anything', undefined, null)).toBe(false);
  });

  it('keeps only recipients at the inbox domain, once each, in any case', () => {
    const env = JSON.stringify({ to: ['K7F3Q9@Inbox.Mail.Trubase.org', 'k7f3q9@inbox.mail.trubase.org', 'someone@gmail.com', '<abc123@inbox.mail.trubase.org>'], from: 'x@y.org' });
    expect(inboxRecipients(env, 'inbox.mail.trubase.org')).toEqual(['k7f3q9', 'abc123']);
    expect(inboxRecipients('not json', 'inbox.mail.trubase.org')).toEqual([]);
  });

  it('counts a message as authentic only when DKIM or SPF passes for the From: domain', () => {
    expect(parseDkim('{@ojcfund.org : pass, @sendgrid.info : fail}')).toEqual([{ domain: 'ojcfund.org', result: 'pass' }, { domain: 'sendgrid.info', result: 'fail' }]);
    // Forwarded by Gmail: SPF is Google's, but OJC's DKIM signature survived.
    expect(authenticity('notifications@ojcfund.org', '{@ojcfund.org : pass}', 'softfail', 'congoizer+caf_=x@gmail.com').authentic).toBe(true);
    expect(authenticity('alerts@mail.chase.com', '{@chase.com : pass}', 'none', null).authentic).toBe(true);    // same organizational domain
    expect(authenticity('notifications@ojcfund.org', null, 'pass', 'bounce@ojcfund.org').authentic).toBe(true);
    // A forgery: signed by someone else's domain, SPF for another sender.
    const forged = authenticity('notifications@ojcfund.org', '{@evil.example : pass}', 'pass', 'x@evil.example');
    expect(forged.authentic).toBe(false);
    expect(forged.reason).toMatch(/No DKIM or SPF pass aligned with ojcfund.org/);
    expect(authenticity(null, '{@ojcfund.org : pass}', 'pass', null).authentic).toBe(false);
  });

  it('masks card numbers to their last 4, and leaves other numbers alone', () => {
    expect(maskCards('Card 4111 1111 1111 1111 charged')).toBe('Card •••• 1111 charged');
    expect(maskCards('Card 4111-1111-1111-1111')).toBe('Card •••• 1111');
    expect(maskCards('ACH id 1769123, account 123456789012, phone 8455551234')).toBe('ACH id 1769123, account 123456789012, phone 8455551234');
  });

  it('makes safe storage names and spots Gmail forwarding confirmations', () => {
    expect(safeName('ACH 2026-11-18 (1).pdf', 1)).toBe('1-ACH_2026-11-18_1_.pdf');
    const evil = safeName('../../etc/passwd', 2);
    expect(evil).not.toMatch(/\/|\.\./);
    expect(evil.startsWith('2-')).toBe(true);
    expect(safeName(null, 3)).toBe('3-attachment');
    expect(isForwardingConfirmation('forwarding-noreply@google.com', '(#123) Gmail Forwarding Confirmation - Receive Mail from x')).toBe(true);
    expect(isForwardingConfirmation('someone@google.com', 'Gmail Forwarding Confirmation')).toBe(false);
  });
});
