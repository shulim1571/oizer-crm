// Two-step verification codes by text or voice call (Shulim, 2026-11-11): the words sent, and the number they come
// from. The code itself is made and checked by the database; this only formats it for Twilio.

/** Oizer's own Twilio number; codes are never sent from any other number. */
export const MFA_FROM = '+18456134272';

export const smsBody = (code: string) =>
  `Your Donor Base code is ${code}. It expires in 10 minutes. Don't share it with anyone.`;

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/** A voice call that reads the code slowly, digit by digit, twice. */
export function callTwiml(code: string): string {
  const digits = code.replace(/\D/g, '').split('').join(', ');
  const say = (t: string) => `<Say voice="Polly.Joanna">${escapeXml(t)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/>${say('Your Donor Base sign in code is:')}<Pause length="1"/>${say(digits + '.')}<Pause length="1"/>${say('Again, your code is:')}<Pause length="1"/>${say(digits + '.')}${say('Goodbye.')}</Response>`;
}
