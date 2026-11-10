import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every table column that names a campaign links to the campaign's page (Moshe Henig, 2026-11-10).
// Columns counting campaigns ("Campaigns": 3) or listing several aren't one campaign, so they're left plain.
const dir = join(__dirname, '..', 'pages');
const files = readdirSync(dir).filter(f => f.endsWith('.tsx'));

describe('campaign columns', () => {
  it('link to the campaign wherever a list names one', () => {
    const missing: string[] = [];
    for (const f of files) {
      const s = readFileSync(join(dir, f), 'utf8');
      for (const m of s.matchAll(/\{ key: '(campaign|campaign_id|campaign_name|campaign_label)', label: 'Campaign'[^\n]*/g)) {
        // The printed campaign report (Reports REPORT_COLUMNS, `get:`) is a printout, not a page with links.
        if (m[0].includes('get:') || s.slice(Math.max(0, m.index! - 80), m.index).includes('before:')) continue;
        if (!m[0].includes('campaignLink') && !m[0].includes('<Link')) missing.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
