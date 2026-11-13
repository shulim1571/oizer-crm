// Plaid settings and transaction mapping for the plaid function. Sandbox (Shulim, 2026-11-11), and production for real
// bank connections since Shulim approved it for Oizer (2026-11-13).
//
// The keys come only from the environment (Supabase secrets when deployed, the shell's environment locally):
// PLAID_CLIENT_ID, and the secret for the environment PLAID_ENV names: PLAID_SANDBOX_SECRET for sandbox (the
// default) or PLAID_PRODUCTION_SECRET for production. Anything else is refused. Nothing here prints, logs or returns a
// key; error messages name the setting, never its value.

export type PlaidEnv = 'sandbox' | 'production';
export type PlaidConfig = { ok: true; clientId: string; secret: string; env: PlaidEnv; baseUrl: string } | { ok: false; error: string };

const ENVS: Record<PlaidEnv, { secret: string; baseUrl: string }> = {
  sandbox: { secret: 'PLAID_SANDBOX_SECRET', baseUrl: 'https://sandbox.plaid.com' },
  production: { secret: 'PLAID_PRODUCTION_SECRET', baseUrl: 'https://production.plaid.com' },
};

export function plaidConfig(get: (name: string) => string | undefined): PlaidConfig {
  const asked = (get('PLAID_ENV') ?? '').trim().toLowerCase() || 'sandbox';
  if (!(asked in ENVS)) return { ok: false, error: `PLAID_ENV has to be sandbox or production (it is "${asked === 'development' ? 'development' : 'something else'}").` };
  const env = asked as PlaidEnv;
  const clientId = (get('PLAID_CLIENT_ID') ?? '').trim();
  const secret = (get(ENVS[env].secret) ?? '').trim();
  const missing = [!clientId && 'PLAID_CLIENT_ID', !secret && ENVS[env].secret].filter(Boolean);
  if (missing.length) return { ok: false, error: `Plaid isn't set up yet: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.` };
  return { ok: true, clientId, secret, env, baseUrl: ENVS[env].baseUrl };
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
