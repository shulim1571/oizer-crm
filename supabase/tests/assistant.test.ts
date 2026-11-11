import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// AI help assistant settings and limits (Shulim, 2026-11-11).
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const FAKE_KEY = 'sk-ant-api03-TESTONLY-not-a-real-key-0000000000';
const save = (db: PGlite, enabled: boolean, limit = 2, model = 'claude-haiku-5-5', user = ADMIN) =>
  rows(db, user, `select public.save_ai_settings($1, $2, 600, $3)`, [enabled, model, limit]);

describe('AI help assistant', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('is off by default, and only the organization’s admins change its settings', async () => {
    expect(await rows(db, ADMIN, `select enabled, model, max_tokens, daily_limit, own_key_set from public.ai_settings()`))
      .toEqual([{ enabled: false, model: 'claude-haiku-5-5', max_tokens: 600, daily_limit: 20, own_key_set: false }]);
    await expect(rows(db, MANAGER_1, `select public.save_ai_settings(true, 'claude-haiku-5-5', 600, 20)`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select public.set_ai_key($1)`, [FAKE_KEY])).rejects.toThrow();
    expect(await rows(db, MANAGER_1, `select * from public.ai_settings()`)).toEqual([]);
    await expect(save(db, true, 20, 'gpt-4')).rejects.toThrow();
    await expect(rows(db, ADMIN, `select public.save_ai_settings(true, 'claude-haiku-5-5', 99999, 20)`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select * from public.ai_begin_question()`)).rejects.toThrow(/turned off/);
  });

  it('keeps the organization’s own key encrypted and write-only, and hands it only to the server', async () => {
    await expect(rows(db, ADMIN, `select public.set_ai_key('not-a-key')`)).rejects.toThrow(/start with sk-ant-/);
    await rows(db, ADMIN, `select public.set_ai_key($1)`, [FAKE_KEY]);
    const [s] = await rows(db, ADMIN, `select * from public.ai_settings()`);
    expect(s.own_key_set).toBe(true);
    expect(JSON.stringify(s)).not.toContain('TESTONLY');
    const [raw] = (await db.query<Record<string, any>>(`select encode(api_key, 'escape') as k from public.ai_assistant_settings`)).rows;
    expect(raw.k).not.toContain('TESTONLY');
    await expect(rows(db, ADMIN, `select * from public.ai_assistant_settings`)).rejects.toThrow();
    await expect(rows(db, ADMIN, `select public.ai_org_key($1)`, [OIZER])).rejects.toThrow();
    expect((await svc(db, `select public.ai_org_key($1) as k`, [OIZER])).k).toBe(FAKE_KEY);
    await rows(db, ADMIN, `select public.set_ai_key(null)`);
    expect((await svc(db, `select public.ai_org_key($1) as k`, [OIZER])).k).toBeNull();
  });

  it('lets staff ask up to the daily limit; failed calls don’t count', async () => {
    await save(db, true, 2);
    expect(await rows(db, MANAGER_1, `select enabled, remaining from public.ai_available()`)).toEqual([{ enabled: true, remaining: 2 }]);
    const [q1] = await rows(db, MANAGER_1, `select * from public.ai_begin_question()`);
    expect(q1).toMatchObject({ org_id: OIZER, model: 'claude-haiku-5-5', max_tokens: 600, remaining: 1 });
    await svc(db, `select public.ai_finish_question($1, 'failed', null, null, null, null)`, [q1.usage_id]);
    const [q2] = await rows(db, MANAGER_1, `select * from public.ai_begin_question()`);
    await svc(db, `select public.ai_finish_question($1, 'answered', 120, 80, 3300, 0)`, [q2.usage_id]);
    const [q3] = await rows(db, MANAGER_1, `select * from public.ai_begin_question()`);
    expect(q3.remaining).toBe(0);
    await expect(rows(db, MANAGER_1, `select * from public.ai_begin_question()`)).rejects.toThrow(/daily limit/);
    // Another person has their own allowance.
    expect((await rows(db, ADMIN, `select * from public.ai_begin_question()`))[0].remaining).toBe(1);
    // Admins see the usage, not the questions.
    const usage = await rows(db, ADMIN, `select period, model, questions, input_tokens, output_tokens, cache_read_tokens from public.ai_usage_summary()`);
    expect(usage).toContainEqual({ period: 'today', model: 'claude-haiku-5-5', questions: 1, input_tokens: 120, output_tokens: 80, cache_read_tokens: 3300 });
    expect(await rows(db, MANAGER_1, `select * from public.ai_usage_summary()`)).toEqual([]);
  });

  it('is for staff only: not anonymous visitors', async () => {
    await save(db, true);
    await expect(rows(db, 'anon', `select * from public.ai_begin_question()`)).rejects.toThrow();
    await expect(rows(db, 'anon', `select * from public.ai_available()`)).rejects.toThrow();
  });
});
