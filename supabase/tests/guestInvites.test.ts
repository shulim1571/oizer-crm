import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Readiness #63 (2026-11-15): a campaign guest gets an invitation email (held while sending is in test mode).
describe('guest invitations', () => {
  it('queue an invitation when a guest is added, and can be sent again', async () => {
    const db = await seededDb();
    await as(db, ADMIN, tx => tx.query(`insert into public.campaign_guests (campaign_id, email) values ('1001', 'friend@example.org')`), OIZER);
    const msgs = async () => (await db.query<{ subject: string; body: string; status: string; to_address: string }>(
      `select subject, body, status, to_address from public.messages where kind = 'guest_invite' order by created_at`)).rows;
    const [m] = await msgs();
    expect(m.to_address).toBe('friend@example.org');
    expect(m.subject).toMatch(/You're invited to follow/);
    expect(m.body).toMatch(/sign up.*with this email address \(friend@example.org\)/);
    expect(m.body).toMatch(/ on FundBase\./);   // renamed from Donor Base (Shulim, 2026-11-22)
    expect(m.status).toBe('held');   // test mode: nothing leaves until sending goes live
    await rows(db, ADMIN, `select public.resend_guest_invite('1001', 'friend@example.org')`, [], OIZER);
    expect(await msgs()).toHaveLength(2);
    await expect(rows(db, ADMIN, `select public.resend_guest_invite('1001', 'stranger@example.org')`, [], OIZER)).rejects.toThrow(/isn't on this campaign/);
  });
});
