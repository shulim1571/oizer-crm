import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard pie (Moshe Henig, 2026-11-11)', () => {
  it('sits beside Donations over time, which is unchanged', () => {
    const d = readFileSync('src/pages/Dashboard.tsx', 'utf8');
    expect(d).toContain('<div className="dash-row">');
    expect(d).toContain('<MethodPie methods={(s?.methods as MethodTotal[] | undefined) ?? []} />');
    expect(d).toContain('<DailyChart daily={s?.daily ?? []} from={from} to={to} />');
  });
});

describe('dashboard All Time box (Moshe Henig, 2026-11-11)', () => {
  it('replaces This week', () => {
    const d = readFileSync('src/pages/Dashboard.tsx', 'utf8');
    expect(d).toContain('<Kpi label="All time" value={money(per(\'all\')?.raised ?? 0)}');
    expect(d).not.toContain('<Kpi label="This week"');
  });
});
