import type { ReactNode } from 'react';
import { money } from '../lib/format';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | '';

export function Pill({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

const TONES: Record<string, Tone> = {
  Payment: 'green', Batch: 'blue', Collect: 'amber', Voided: 'red',
  Pending: 'amber', 'In Progress': 'blue', Done: 'green',
  Active: 'green', Archived: '',
  admin: 'violet', manager: 'blue', pending: 'amber',
};

export const StatusPill = ({ value }: { value: string | null | undefined }) =>
  value ? <Pill tone={TONES[value] ?? ''}>{value}</Pill> : null;

export const Balance = ({ value }: { value: unknown }) => {
  const n = Number(value ?? 0);
  return <span className={n < 0 ? 'amount-neg' : n > 0 ? 'amount-pos' : 'num'}>{money(n)}</span>;
};
