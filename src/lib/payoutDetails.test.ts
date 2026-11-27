import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig with Shulim's condition, 2026-11-11: opening a payout request shows the full payee and bank details
// to org admins only (the database decides and logs every reveal); everyone else keeps the masked view.
const src = readFileSync('src/pages/Payouts.tsx', 'utf8');

describe('payout request details on opening', () => {
  it('asks the database for the full details as soon as an ACH or Zelle request is opened', () => {
    expect(src).toMatch(/if \(!r \|\| !\(r\.method === 'ACH' \|\| r\.method === 'Zelle'\)\) return;[^]*supabase\.rpc\('payout_request_details', \{ p_request: requestId \}\)/);
    expect(src).not.toContain('Show (logged)');
  });

  it('shows the full payee name, bank, routing and account numbers, or the Zelle address', () => {
    expect(src).toContain('<dt>Payee</dt><dd><b>{r.recipient_name}</b>');
    expect(src).toContain('<dt>Routing number</dt><dd className="num">{details!.routing ?? \'—\'}</dd>');
    expect(src).toContain('<dt>Account number</dt><dd className="num">{details!.account ?? \'—\'}</dd>');
    expect(src).toContain("{full ? (details!.zelle ?? '—') : r.zelle_hint}");
  });

  it('falls back to the masked view when the database refuses', () => {
    expect(src).toContain('setDetails(e ? { _denied: true } :');
    expect(src).toContain('const full = !!details && !details._denied;');
    expect(src).toContain('routing ending {r.routing_last4} · account ending {r.account_last4}');
  });
});
