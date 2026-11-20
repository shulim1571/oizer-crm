// Make ingest: see _shared/makeIngest.ts. Deployed with JWT verification off; every call is authenticated by the
// organization's own secret (x-donorbase-key header), checked in the database. Platform settings come from the
// standard SUPABASE_URL and SUPABASE_SECRET_KEYS environment variables; nothing organization-specific is here.

import { handleMakeIngest, makeRpc } from '../_shared/makeIngest.ts';
import { secretKey } from '../_shared/keys.ts';

const rpc = makeRpc(Deno.env.get('SUPABASE_URL')!, secretKey());

Deno.serve(req => handleMakeIngest(req, rpc));
