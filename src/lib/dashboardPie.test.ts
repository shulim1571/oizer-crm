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

describe('dashboard Recurring Transactions box (Moshe Henig, 2026-11-11)', () => {
  it('is named Recurring transactions and adds up the upcoming recurring charges', () => {
    const d = readFileSync('src/pages/Dashboard.tsx', 'utf8');
    expect(d).toContain('<Kpi label="Recurring transactions"');
    expect(d).not.toContain('label="Recurring pledges"');
    expect(d).toContain("supabase.from('recurring_list').select('amount, due_30, due_90').eq('status', 'active')");
    expect(d).toContain("next30: list.reduce((t, r) => t + Number(r.amount) * Number(r.due_30 ?? 0), 0),");
  });
});
