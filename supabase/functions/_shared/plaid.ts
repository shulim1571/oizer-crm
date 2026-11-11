// Plaid settings and transaction mapping for the plaid function. Sandbox only (Shulim, 2026-11-11).
//
// The keys come only from the environment: PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET (Supabase secrets when
// deployed, the shell's environment locally), with PLAID_ENV choosing the environment and defaulting to sandbox.
// Nothing here prints, logs or returns a key; error messages name the setting, never its value.

export type PlaidConfig = { ok: true; clientId: string; secret: string; env: 'sandbox'; baseUrl: string } | { ok: false; error: string };

export function plaidConfig(get: (name: string) => string | undefined): PlaidConfig {
  const env = (get('PLAID_ENV') ?? '').trim().toLowerCase() || 'sandbox';
  if (env !== 'sandbox') return { ok: false, error: `Only the Plaid sandbox is allowed here (PLAID_ENV is "${env === 'production' || env === 'development' ? env : 'not sandbox'}").` };
  const clientId = (get('PLAID_CLIENT_ID') ?? '').trim();
  const secret = (get('PLAID_SANDBOX_SECRET') ?? '').trim();
  const missing = [!clientId && 'PLAID_CLIENT_ID', !secret && 'PLAID_SANDBOX_SECRET'].filter(Boolean);
  if (missing.length) return { ok: false, error: `Plaid isn't set up yet: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.` };
  return { ok: true, clientId, secret, env: 'sandbox', baseUrl: 'https://sandbox.plaid.com' };
}

/** A Plaid transaction as /transactions/sync returns it (the parts used here). */
export interface PlaidTxn {
  transaction_id: string; account_id: string; amount: number; date: string; pending?: boolean;
  name?: string | null; merchant_name?: string | null; check_number?: string | null;
}

/** A bank line for plaid_apply_sync. Plaid counts money leaving the account as positive; bank lines count deposits as positive. */
export interface SyncLine { id: string; date: string; amount: number; description: string | null; check_number: string | null }

export function toSyncLines(txns: PlaidTxn[], plaidAccountId: string): SyncLine[] {
  return txns
    .filter(t => t.account_id === plaidAccountId && !t.pending && Number(t.amount) !== 0)
    .map(t => ({
      id: t.transaction_id,
      date: t.date,
      amount: Math.round(-Number(t.amount) * 100) / 100,
      description: (t.merchant_name || t.name || '').trim() || null,
      check_number: t.check_number ?? null,
    }));
}

/** Plaid's own words for an error, without anything that was sent to it. */
export function plaidError(body: unknown, status: number): string {
  const b = body as { error_message?: string; error_code?: string } | null;
  return b?.error_message ? `Plaid: ${b.error_message}${b.error_code ? ` (${b.error_code})` : ''}` : `Plaid didn't answer (${status}).`;
}
