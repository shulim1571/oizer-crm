import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: "Email to fundraiser" sends the check PDF to the campaign's fundraiser; it completes the
// check's task like printing, and both stay possible.
const sql = (db: PGlite, q: string, p: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, p));
const one = async <T = any>(db: PGlite, q: string, p: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, p))[0];
const PDF = 'JVBERi0xLjcK' + 'A'.repeat(200);

describe('email a check to the fundraiser', () => {
  let db: PGlite;
  let check: { check_id: string; check_number: number };
  beforeEach(async () => {
    db = await seededDb();
    await sql(db, `update public.managers set email = 'm1@example.org' where id = 'm1'`);
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', '1 Main St', 'Chase', '021000021', '123456789', 7001)`);
    const p = await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method) values ('1001', 180, 'Acme', 'Check') returning id`);
    check = await one(db, `select * from public.issue_check($1, 'a1', null)`, [p.id]);
  });

  it('queues an email with the PDF to the campaign’s primary fundraiser and clears the check’s task', async () => {
    expect((await one(db, `select count(*)::int n from public.admin_task_sheet where task_key = $1`, ['check_unprinted:' + check.check_id])).n).toBe(1);
    const r = await one<{ r: any }>(db, `select public.email_check_to_fundraiser($1, $2) r`, [check.check_id, PDF]);
    expect(r.r).toMatchObject({ to: 'm1@example.org' });
    const msg = (await db.query<{ to_address: string; subject: string; kind: string }>(`select to_address, subject, kind from public.messages where id = $1`, [r.r.message_id])).rows[0];
    expect(msg).toEqual({ to_address: 'm1@example.org', subject: 'Check #7001 to Acme from Oizer Umoshia', kind: 'check' });
    expect((await db.query(`select name from public.message_attachments where message_id = $1`, [r.r.message_id])).rows).toEqual([{ name: 'check-7001.pdf' }]);
    expect((await one(db, `select count(*)::int n from public.admin_task_sheet where task_key = $1`, ['check_unprinted:' + check.check_id])).n).toBe(0);
    expect((await one(db, `select emailed_to from public.check_register where id = $1`, [check.check_id])).emailed_to).toBe('m1@example.org');
  });

  it('leaves printing possible afterwards, and can email again after printing', async () => {
    await sql(db, `select public.email_check_to_fundraiser($1, $2)`, [check.check_id, PDF]);
    await sql(db, `select public.mark_check_printed($1)`, [check.check_id]);
    await sql(db, `select public.email_check_to_fundraiser($1, $2)`, [check.check_id, PDF]);
    expect((await db.query(`select count(*)::int n from public.messages where kind = 'check'`)).rows[0]).toEqual({ n: 2 });
  });

  it('is for admins, and says so when the fundraiser has no email', async () => {
    await expect(sql(db, `select public.email_check_to_fundraiser($1, $2)`, [check.check_id, PDF], MANAGER_1)).rejects.toThrow();
    await sql(db, `update public.managers set email = null where id = 'm1'`);
    await expect(sql(db, `select public.email_check_to_fundraiser($1, $2)`, [check.check_id, PDF])).rejects.toThrow(/no email address/);
  });

  it('hands the PDF to the sender with the email', async () => {
    await db.query(`insert into public.messaging_settings (org_id, live) values ((select org_id from public.checks where id = $1), true) on conflict (org_id) do update set live = true`, [check.check_id]);
    const r = await one<{ r: any }>(db, `select public.email_check_to_fundraiser($1, $2) r`, [check.check_id, PDF]);
    const claimed = (await rows<{ id: string; attachment_name: string; attachment: string }>(db, 'service_role', `select id, attachment_name, attachment from public.claim_messages(50)`)).find(m => m.id === r.r.message_id);
    expect(claimed).toMatchObject({ attachment_name: 'check-7001.pdf', attachment: PDF });
  });
});
