// Make ingest: see _shared/makeIngest.ts. Deployed with JWT verification off; every call is authenticated by the
// organization's own secret (x-donorbase-key header), checked in the database. Platform settings come from the
// standard SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables; nothing organization-specific is here.

import { handleMakeIngest, makeRpc } from '../_shared/makeIngest.ts';

const rpc = makeRpc(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(req => handleMakeIngest(req, rpc));
