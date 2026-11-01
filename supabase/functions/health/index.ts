// Reports whether the database answers and scheduled jobs are running, for uptime monitors.
// Returns only yes/no flags and a timestamp. Responds 503 when anything is wrong.
Deno.serve(async () => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  let body = { database: false, jobs: false, last_heartbeat: null as string | null };
  try {
    const res = await fetch(`${url}/rest/v1/rpc/health_check`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) body = await res.json();
  } catch {
    // Leaves everything false, which reports as down.
  }
  const healthy = body.database && body.jobs;
  return Response.json({ status: healthy ? 'ok' : 'degraded', ...body }, { status: healthy ? 200 : 503 });
});
