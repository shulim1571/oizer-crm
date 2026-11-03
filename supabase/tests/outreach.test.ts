import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
type Msg = { to_address: string; to_name: string; subject: string; body: string; html: string; status: string; channel: string; send_after: string; unsubscribe_token: string };
const sent = async (db: PGlite, kind: string) =>
  (await db.query<Msg>(`select * from public.messages where kind = $1 order by channel, to_address`, [kind])).rows;
const share = (db: PGlite, channel: string, to: string[], message: string | null = null, user = ADMIN) =>
  one(db, `select public.share_campaign_link('1001', $1, $2, null, $3) r`, [channel, to, message], user).then(x => x.r);
const outreach = (db: PGlite, channel: string, recipients: unknown[], extra: { subject?: string; body?: string; sms?: string; after?: string | null; pdf?: [string, string] } = {}) =>
  one(db, `select public.send_outreach($1, $2, $3, $4, $5, $6, $7, $8) r`, [channel, extra.subject ?? 'Hello {first_name}', extra.body ?? 'Dear {first_name} {last_name},\n**Thank you** for supporting {campaign_name}.',
    extra.sms ?? 'Hi {first_name}, thanks!', JSON.stringify(recipients), extra.after ?? null, extra.pdf?.[0] ?? null, extra.pdf?.[1] ?? null]).then(x => x.r);

describe('sharing and outreach', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.org_domains (hostname, org_id) values ('oizer.example.org', $1) on conflict do nothing`, [OIZER]);
    await base.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
    await base.query(`update public.organizations set check_payee = 'Cong. Oizer', zelle = 'give@oizer.org', ein = '99-0000000', address = '1 Main St' where id = $1`, [OIZER]);
    await base.query(`update public.campaigns set payment_link = 'https://give.example.org/1001', external_name = 'Building Fund' where id = '1001'`);
    await base.query(`update public.donors set email = 'donor1@example.org', phone = '7185550101' where id = 'd1'`);
    await base.query(`update public.donors set email = 'donor2@example.org' where id = 'd2'`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('share the link with the giving details, a message and an unsubscribe link', async () => {
    const r = await share(db, 'email', ['a@example.org', 'A@example.org ', 'nope'], 'Please help us finish!');
    expect(r.queued).toBe(1);
    expect(r.skipped).toEqual([{ to: 'nope', reason: '"nope" isn\'t a valid email address' }]);
    const [m] = await sent(db, 'share');
    expect(m.subject).toBe('Support Building Fund');
    expect(m.body).toContain('Please help us finish!\n\nDonate here: https://give.example.org/1001\nMake checks payable to: Cong. Oizer\nZelle: give@oizer.org\nEIN: 99-0000000');
    expect(m.body).toContain(`Unsubscribe: https://oizer.example.org/#/u/${m.unsubscribe_token}`);
    expect(m.html).toContain('<a href="https://give.example.org/1001">https://give.example.org/1001</a>');
    expect(m.html).toContain(`href="https://oizer.example.org/#/u/${m.unsubscribe_token}"`);
    expect(m.html).toContain('1 Main St');
  });

  it('share by text with opt-out wording', async () => {
    await share(db, 'sms', ['(718) 555-0100']);
    const [m] = await sent(db, 'share');
    expect(m.body).toBe('https://give.example.org/1001\nChecks: Cong. Oizer\nZelle: give@oizer.org\nEIN: 99-0000000\nReply STOP to opt out.');
  });

  it('let fundraisers share only their own campaigns, and see that history', async () => {
    await share(db, 'email', ['x@example.org'], null, MANAGER_1);
    await expect(share(db, 'email', ['x@example.org'], null, MANAGER_2)).rejects.toThrow(/only for your own campaigns/);
    expect(await rows(db, MANAGER_1, `select to_address, created_by from public.campaign_shares('1001')`)).toEqual([{ to_address: 'x@example.org', created_by: 'one@example.org' }]);
    expect(await rows(db, MANAGER_2, `select * from public.campaign_shares('1001')`)).toEqual([]);
    await db.query(`update public.campaigns set payment_link = null where id = '1001'`);
    await expect(share(db, 'email', ['x@example.org'])).rejects.toThrow(/no payment link yet/);
  });

  it('stop marketing email after an unsubscribe, but never receipts and notices', async () => {
    await share(db, 'email', ['a@example.org']);
    const [m] = await sent(db, 'share');
    expect(await rows(db, 'anon', `select public.unsubscribe_email($1) org`, [m.unsubscribe_token])).toEqual([{ org: 'Oizer Umoshia' }]);
    expect(await rows(db, 'anon', `select public.unsubscribe_email('guess') org`)).toEqual([{ org: null }]);
    await share(db, 'email', ['a@example.org']);
    expect((await sent(db, 'share')).map(x => x.status)).toEqual(['queued', 'opted_out']);
    await sql(db, `select public.send_test_message('email', 'a@example.org')`);
    expect((await sent(db, 'test'))[0].status).toBe('queued');
  });

  it('personalize outreach per recipient, by email and text, skipping who can\'t be reached', async () => {
    const r = await outreach(db, 'both', [
      { kind: 'donor', id: 'd1', campaign_id: '1001' },
      { kind: 'donor', id: 'd2' },
      { kind: 'address', address: 'walkin@example.org' },
      { kind: 'address', address: 'walkin@example.org' },
      { kind: 'fundraiser', id: 'm1' },
    ]);
    expect(r.queued).toBe(5);
    const m = await sent(db, 'outreach');
    expect(m.map(x => [x.channel, x.to_address])).toEqual([
      ['email', 'donor1@example.org'], ['email', 'donor2@example.org'], ['email', 'one@example.org'], ['email', 'walkin@example.org'], ['sms', '+17185550101'],
    ]);
    const d1 = m.find(x => x.to_address === 'donor1@example.org')!;
    expect(d1.subject).toBe('Hello Donor');
    expect(d1.body).toMatch(/^Dear Donor One,\n\*\*Thank you\*\* for supporting Building Fund\./);
    expect(d1.html).toContain('<b>Thank you</b> for supporting Building Fund.');
    expect(m.find(x => x.channel === 'sms')!.body).toBe('Hi Donor, thanks!\nReply STOP to opt out.');
    const walkin = m.find(x => x.to_address === 'walkin@example.org')!;
    expect(walkin.body).toMatch(/^Dear  ,/);
    expect(await rows(db, ADMIN, `select count(*)::int n from public.donors where email = 'walkin@example.org'`)).toEqual([{ n: 0 }]);
  });

  it('report recipients with no address for the channel', async () => {
    const r = await outreach(db, 'sms', [{ kind: 'donor', id: 'd2' }, { kind: 'fundraiser', id: 'm1' }]);
    expect(r.queued).toBe(0);
    expect(r.skipped.map((s: any) => s.reason)).toEqual(['No valid phone number', 'No valid phone number']);
  });

  it('schedule a send, and cancel what hasn\'t gone', async () => {
    const r = await outreach(db, 'email', [{ kind: 'donor', id: 'd1' }], { after: '2099-01-01T15:00:00Z' });
    const before = (await db.query(`select count(*)::int n from net.requests`)).rows[0];
    expect((await sent(db, 'outreach'))[0].status).toBe('queued');
    expect(await rows(db, 'service_role', `select * from public.claim_messages(10)`)).toEqual([]);
    expect(await one(db, `select public.cancel_outreach($1) n`, [r.id])).toEqual({ n: 1 });
    expect((await sent(db, 'outreach'))[0].status).toBe('cancelled');
    expect((await db.query(`select count(*)::int n from net.requests`)).rows[0]).toEqual(before);
  });

  it('carry a PDF to the sender, and refuse anything else', async () => {
    await expect(outreach(db, 'email', [{ kind: 'donor', id: 'd1' }], { pdf: ['letter.docx', 'AAAA'] })).rejects.toThrow(/Attach a PDF/);
    await outreach(db, 'email', [{ kind: 'donor', id: 'd1' }], { pdf: ['letter.pdf', 'JVBERi0='] });
    const [c] = await rows(db, 'service_role', `select attachment_name, attachment, unsubscribe_url from public.claim_messages(10)`);
    expect(c.attachment_name).toBe('letter.pdf');
    expect(c.attachment).toBe('JVBERi0=');
    expect(c.unsubscribe_url).toMatch(/^https:\/\/oizer\.example\.org\/#\/u\/[0-9a-f]{32}$/);
  });

  it('roll up delivery, opens and clicks per send', async () => {
    const r = await outreach(db, 'email', [{ kind: 'donor', id: 'd1' }, { kind: 'donor', id: 'd2' }]);
    const ids = (await db.query<{ id: string }>(`select id from public.messages where kind = 'outreach' order by to_address`)).rows.map(x => x.id);
    await rows(db, 'service_role', `select * from public.claim_messages(10)`);
    for (const id of ids) await rows(db, 'service_role', `select public.message_sent($1, $2, true, null, null)`, [OIZER, id]);
    await rows(db, 'service_role', `select public.message_event($1, $2, null, 'delivered', null, now())`, [OIZER, ids[0]]);
    await rows(db, 'service_role', `select public.message_event($1, $2, null, 'click', null, now())`, [OIZER, ids[0]]);
    expect(await one(db, `select recipient_count, queued_count, sent, delivered, opened, clicked from public.outreach_list where id = $1`, [r.id]))
      .toEqual({ recipient_count: 2, queued_count: 2, sent: 2, delivered: 1, opened: 1, clicked: 1 });
  });

  it('keep outreach, its groups and templates to admins', async () => {
    await expect(outreach(db, 'email', [])).rejects.toThrow(/at least one recipient/);
    await expect(sql(db, `select public.send_outreach('email', 'S', 'B', null, '[{"kind":"donor","id":"d1"}]')`, [], MANAGER_1)).rejects.toThrow();
    expect((await rows(db, ADMIN, `select id from public.outreach_group('campaign_donors', '1001')`)).map(x => x.id)).toEqual(['d1', 'd2']);
    expect((await rows(db, ADMIN, `select id from public.outreach_group('primary_fundraisers')`)).map(x => x.id).sort()).toEqual(['m1', 'm2']);
    const t = (await one(db, `select public.save_outreach_template(null, 'Annual Appeal', 'Subject', 'Body', 'Text') id`)).id;
    await sql(db, `select public.save_outreach_template($1, 'Annual Appeal 2', 'Subject', 'Body', null)`, [t]);
    expect(await rows(db, ADMIN, `select name, sms_body from public.outreach_templates`)).toEqual([{ name: 'Annual Appeal 2', sms_body: null }]);
    expect(await rows(db, MANAGER_1, `select * from public.outreach_templates`)).toEqual([]);
  });

  it('format typed text safely', async () => {
    const r = await one(db, `select public.format_message_html($1) h`, ['<script>x</script> **bold** *it* see https://a.org/x?y=1&z=2.\nnext']);
    expect(r.h).toBe('&lt;script&gt;x&lt;/script&gt; <b>bold</b> <i>it</i> see <a href="https://a.org/x?y=1&amp;z=2">https://a.org/x?y=1&amp;z=2</a>.<br>next');
  });
});
