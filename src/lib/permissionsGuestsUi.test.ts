import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #63 (2026-11-15): the permissions grid explains each column in plain words; guests get invitations.
describe('Users page', () => {
  const u = readFileSync('src/pages/Users.tsx', 'utf8');
  it('lists what each permission allows, visibly, under the grid', () => {
    expect(u).toContain('<dl className="perm-help">');
    expect(u).toContain('<div key={i.key}><dt>{i.short}</dt><dd>{i.full}</dd></div>');
  });
  it('queues a guest invitation and can send it again', () => {
    expect(u).toContain("supabase.rpc('resend_guest_invite', { p_campaign: g.campaign_id, p_email: g.email })");
    expect(u).toContain('queued their invitation email');
  });
});
