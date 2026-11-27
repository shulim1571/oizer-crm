import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #32 (2026-11-15): reconciliation summary, exports and the Match automatically explanation.
describe('reconciliation page', () => {
  const r = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
  it('shows deposits in transit and the unreconciled bank total per account', () => {
    expect(r).toContain('<Kpi label="Deposits in transit" value={String(a.deposits_unmatched ?? 0)}');
    expect(r).toContain('sub={`${money(a.unmatched_total)} unreconciled`}');
  });
  it('exports the unmatched items and each signed-off period as CSV, and prints the period (PDF)', () => {
    expect(r).toContain('onClick={exportUnmatched}>Unmatched list (CSV)</button>');
    expect(r).toContain("onClick={() => periodCsv(p, accountName)}>CSV</button>");
    expect(r).toContain('<Printer size={16} /> Print / PDF</button>');
  });
  it('explains Match automatically in one line, and keeps Unmatch with who matched and when', () => {
    expect(r).toContain('Match automatically pairs checks by number and amount, then one bank line with one book item of the same amount within 10 days.');
    expect(r).toContain('<Undo2 size={16} /> Unmatch</button>');
    expect(r).toContain("{m.kind === 'auto' ? 'Automatic' : m.created_by}<div className=\"muted\">{dateTime(m.created_at)}</div>");
  });
});
