// Plaid (Shulim: sandbox 2026-11-11; production for Oizer's real bank connections approved 2026-11-13; PLAID_ENV
// chooses, see _shared/plaid.ts): Link, token exchange and transaction sync for a bank account on the
// Reconciliation page. Called by a signed-in admin from the portal. The database checks the admin and the
// account as them first (plaid_admin_check); then this function, which alone has the Plaid keys, talks to
// Plaid and records the result with the service role. Keys are read from secrets only and never logged.

import { plaidConfig, plaidError, toSyncLines, type PlaidTxn } from '../_shared/plaid.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

async function rpc(name: string, args: unknown, auth: { token: string; org?: string } | null) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: auth ? anonKey : serviceKey,
      Authorization: `Bearer ${auth ? auth.token : serviceKey}`,
      'Content-Type': 'application/json',
      ...(auth?.org ? { 'x-org-id': auth.org } : {}),
    },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${name} failed (${res.status})`);
  return body;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'Sign in first.' }, 401);
  const b = await req.json().catch(() => ({})) as Record<string, any>;
  const auth = { token, org: typeof b.org === 'string' ? b.org : undefined };
  const account = String(b.account ?? '');

  const cfg = plaidConfig(n => Deno.env.get(n));
  if (!cfg.ok) return reply({ error: cfg.error, not_set_up: true });
  const plaid = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new Error(plaidError(out, res.status));
    return out;
  };

  // Checked as the admin first: only admins, only their organization's bank accounts.
  let org: string;
  try {
    org = await rpc('plaid_admin_check', { p_account: account }, auth);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 403);
  }

  try {
    switch (b.action) {
      // Which Plaid environment is in use, for the panel's label (no keys, only the name).
      case 'config':
        return reply({ env: cfg.env });
      case 'link_token': {
        const r = await plaid('/link/token/create', {
          client_name: 'Oizer', language: 'en', country_codes: ['US'], products: ['transactions'],
          // A year of history (Shulim, 2026-11-13: only recent transactions came in). Applies to new links; Plaid sends
          // the latest first and the rest over the next while, which the next syncs pick up.
          transactions: { days_requested: 365 },
          user: { client_user_id: `${org}:${account}` },
        });
        return reply({ link_token: r.link_token, env: cfg.env });
      }
      case 'exchange': {
        const pick = b.account_pick ?? {};
        if (typeof b.public_token !== 'string' || typeof pick.id !== 'string') return reply({ error: 'Choose one account in Plaid Link.' }, 400);
        const r = await plaid('/item/public_token/exchange', { public_token: b.public_token });
        await rpc('plaid_save_item', {
          p_org: org, p_account: account, p_item_id: r.item_id, p_access_token: r.access_token,
          p_institution: typeof b.institution === 'string' ? b.institution : null, p_plaid_account: pick.id,
          p_name: typeof pick.name === 'string' ? pick.name : null, p_mask: typeof pick.mask === 'string' ? pick.mask : null,
          p_by: typeof b.by === 'string' ? b.by : null, p_environment: cfg.env,
        }, null);
        return reply({ linked: true });
      }
      case 'sync': {
        const [item] = await rpc('plaid_item_secret', { p_org: org, p_account: account }, null) as { access_token: string; plaid_account_id: string; cursor: string | null; environment: string }[];
        if (!item) return reply({ error: 'This bank account isn\'t linked to Plaid.' }, 400);
        // A link made in the sandbox can't be used in production (or the other way round).
        if (item.environment !== cfg.env) {
          return reply({ error: `This account was linked in the Plaid ${item.environment}, but Plaid is now in ${cfg.env}. Disconnect it and connect the bank again.` }, 400);
        }
        let cursor = item.cursor;
        const totals = { added: 0, updated: 0, removed: 0, pages: 0 };
        try {
          for (let more = true; more && totals.pages < 20; totals.pages++) {
            const r = await plaid('/transactions/sync', { access_token: item.access_token, ...(cursor ? { cursor } : {}), count: 500 });
            const [n] = await rpc('plaid_apply_sync', {
              p_org: org, p_account: account,
              p_added: toSyncLines(r.added as PlaidTxn[], item.plaid_account_id),
              p_modified: toSyncLines(r.modified as PlaidTxn[], item.plaid_account_id),
              p_removed: (r.removed as { transaction_id: string }[]).map(x => x.transaction_id),
              p_cursor: r.next_cursor,
            }, null) as { added: number; updated: number; removed: number }[];
            totals.added += n.added; totals.updated += n.updated; totals.removed += n.removed;
            cursor = r.next_cursor;
            more = !!r.has_more;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await rpc('plaid_record_error', { p_org: org, p_account: account, p_error: message }, null).catch(() => null);
          throw e;
        }
        return reply(totals);
      }
      case 'unlink': {
        const [item] = await rpc('plaid_item_secret', { p_org: org, p_account: account }, null) as { access_token: string; environment: string }[];
        // Plaid is asked to remove the link only in the environment it was made in.
        if (item && item.environment === cfg.env) await plaid('/item/remove', { access_token: item.access_token }).catch(() => null);
        await rpc('plaid_forget', { p_org: org, p_account: account }, null);
        return reply({ unlinked: true });
      }
      default:
        return reply({ error: 'Unknown action' }, 400);
    }
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) });
  }
});
