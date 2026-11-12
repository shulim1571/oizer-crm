import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-12: everyone, fundraisers included, chooses which kinds of notification they get.
describe('notification kinds', () => {
  const page = readFileSync('src/pages/Notifications.tsx', 'utf8');
  it('offers Off for every kind, next to email, text or both, on the same picker for fundraisers and admins', () => {
    expect(page).toContain("['off', 'Off (don\\'t send)']");
    expect(page.match(/<ChannelPick value=\{channel\(k\)\}/g)?.length).toBe(2);
    expect(page).toContain("const channel = (k: string) => f.channels[k] ?? 'email';");   // every kind starts on
  });
  it('keeps the switch for all of them, and the server accepts and honours Off', () => {
    expect(page).toContain("supabase.rpc('set_my_notifications', { p_on: next })");
    const sql = readFileSync('supabase/migrations/20261222003100_notification_kinds_off.sql', 'utf8');
    expect(sql).toContain("where v not in ('email','sms','both','off')");
    expect(sql).toContain("if v_channel = 'off' then");
  });
});
