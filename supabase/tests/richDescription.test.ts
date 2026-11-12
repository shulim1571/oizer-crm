import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: formatted descriptions are stored, but nothing dangerous gets into the database.
describe('formatted campaign description', () => {
  it('saves formatting and shows it on the payment page', async () => {
    const db = await seededDb();
    const html = '<p style="text-align: center"><b>Help</b> <span style="font-family: \'Georgia\'">us</span></p><ul><li>one</li></ul>';
    await as(db, ADMIN, tx => tx.query(`select public.save_page_content('1001', true, true, null, $1, null, null)`, [html]));
    expect((await rows<{ d: string }>(db, 'anon', `select public.public_give_page($1, '1001') -> 'page' ->> 'description' d`, [OIZER]))[0].d).toBe(html);
  });

  it('refuses scripts, event handlers and javascript: links even if a request skips the app', async () => {
    const db = await seededDb();
    for (const bad of ['<script>alert(1)</script>', '<p onclick="x()">hi</p>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://e"></iframe>']) {
      await expect(as(db, ADMIN, tx => tx.query(`select public.save_page_content('1001', true, true, null, $1, null, null)`, [bad]))).rejects.toThrow(/campaign_page_description_safe/);
    }
  });
});
