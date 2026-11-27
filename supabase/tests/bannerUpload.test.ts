import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #55 (2026-11-15): a banner can be an uploaded picture as well as an https:// address.
const save = (db: any, banner: string) => rows(db, ADMIN,
  `select public.save_page_content('1001', true, true, null, null, null, $1)`, [banner], OIZER);

describe('campaign banner', () => {
  it('takes an https address or an uploaded picture, and nothing else', async () => {
    const db = await seededDb();
    await save(db, 'https://example.org/banner.jpg');
    await save(db, 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==');
    const [{ b }] = await rows<{ b: string }>(db, ADMIN, `select banner_url b from public.campaign_page_settings where campaign_id = '1001'`, [], OIZER);
    expect(b.startsWith('data:image/jpeg;base64,')).toBe(true);
    await expect(save(db, 'http://example.org/x.jpg')).rejects.toThrow(/https:\/\/ address or an uploaded picture/);
    await expect(save(db, 'data:text/html;base64,PHNjcmlwdD4=')).rejects.toThrow(/https:\/\/ address or an uploaded picture/);
    await expect(save(db, 'data:image/png;base64,' + 'A'.repeat(700001))).rejects.toThrow(/too large/);
  });
});
