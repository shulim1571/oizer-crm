import type { Column } from '../components/DataTable';
import { Pill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';

/**
 * A campaign's statement (Shulim, 2026-11-25): every movement of its money with the campaign balance after each one,
 * like a bank statement, from campaign_statement (the same rules as the campaign balance; shared teams included, so
 * the newest line is the balance shown at the top). Staff only.
 */
export interface StatementLine {
  kind: 'donation' | 'payout' | 'transfer_in' | 'transfer_out'; id: string; campaign_id: string; at: string; description: string;
  money_in: number | string; fee: number | string; money_out: number | string; change: number | string; balance: number | string;
}

const KIND: Record<StatementLine['kind'], { label: string; tone: 'green' | 'amber' | 'blue' | 'red' }> = {
  donation: { label: 'Gift', tone: 'green' }, payout: { label: 'Payout', tone: 'red' },
  transfer_in: { label: 'Transfer In', tone: 'blue' }, transfer_out: { label: 'Transfer Out', tone: 'amber' },
};
const amount = (v: unknown) => (Number(v) ? money(v as number) : '');

/** The statement, newest first like the other tabs. */
export async function loadStatement(campaignId: string): Promise<StatementLine[]> {
  const { data, error } = await supabase.rpc('campaign_statement', { p_campaign: campaignId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as StatementLine[]).slice().reverse();
}

export const statementColumns = (showCampaign: boolean): Column[] => [
  { key: 'at', label: 'Date', render: r => dateTime(r.at), sortValue: r => r.at },
  { key: 'kind', label: 'Type', value: r => KIND[r.kind as StatementLine['kind']]?.label, render: r => <Pill tone={KIND[r.kind as StatementLine['kind']]?.tone}>{KIND[r.kind as StatementLine['kind']]?.label}</Pill> },
  ...(showCampaign ? [{ key: 'campaign_id', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id }] : []),
  { key: 'description', label: 'Description', long: true },
  { key: 'money_in', label: 'In', align: 'right', value: r => Number(r.money_in), render: r => amount(r.money_in) },
  { key: 'fee', label: 'Fee', align: 'right', value: r => Number(r.fee), render: r => amount(r.fee) },
  { key: 'money_out', label: 'Out', align: 'right', value: r => Number(r.money_out), render: r => amount(r.money_out) },
  { key: 'balance', label: 'Balance', align: 'right', value: r => Number(r.balance), render: r => <b className="num">{money(r.balance)}</b> },
] as Column[];

/** The balance after each listed movement, by "kind:id" (a transfer within the campaign's own group: after both sides). */
export function balanceIndex(lines: StatementLine[]): Map<string, number> {
  const m = new Map<string, number>();
  // Oldest first, so a later line with the same key (the other side of an in-group transfer) wins.
  for (const l of lines.slice().reverse()) {
    const key = l.kind === 'transfer_in' || l.kind === 'transfer_out' ? `transfer:${l.id}` : `${l.kind}:${l.id}`;
    m.set(key, Number(l.balance));
  }
  return m;
}

/** "Balance after" for the Donations, Payouts and Transfers tabs; a row that moves no money (pending, held) shows a dash. */
export const balanceAfterColumn = (index: Map<string, number> | null, kind: 'donation' | 'payout' | 'transfer'): Column => ({
  key: 'balance_after', label: 'Balance after', align: 'right',
  value: r => index?.get(`${kind}:${r.id}`) ?? null,
  render: r => { const b = index?.get(`${kind}:${r.id}`); return b == null ? <span className="muted">—</span> : money(b); },
});
