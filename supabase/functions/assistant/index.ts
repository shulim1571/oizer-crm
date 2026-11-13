// The help assistant (Shulim, 2026-11-11): answers signed-in staff's how-to questions about Oizer with Claude.
// The person's session is checked by the database first (ai_begin_question: staff only, assistant on for their
// organization, daily limit), then this function calls the Claude API with the organization's own key if it has
// one, otherwise the shared ANTHROPIC_API_KEY secret. Keys never leave the server and are never logged.
// No records are sent to the model; questions and answers are not stored, only token counts.

import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { modelOptions, shapeMessages, SYSTEM_PROMPT } from '../_shared/assistant.ts';

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
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const auth = { token, org: typeof b.org === 'string' ? b.org : undefined };

  const shaped = shapeMessages(b.messages, b.page);
  if ('error' in shaped) return reply({ error: shaped.error }, 400);

  // As the person: staff only, assistant on, under today's limit. Books the question.
  let q: { usage_id: number; org_id: string; model: string; max_tokens: number; remaining: number };
  try {
    [q] = await rpc('ai_begin_question', {}, auth);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 403);
  }
  const finish = (status: 'answered' | 'failed', u?: Anthropic.Usage) =>
    rpc('ai_finish_question', {
      p_usage: q.usage_id, p_status: status, p_input: u?.input_tokens ?? null, p_output: u?.output_tokens ?? null,
      p_cache_read: u?.cache_read_input_tokens ?? null, p_cache_write: u?.cache_creation_input_tokens ?? null,
    }, null).catch(() => null);

  const orgKey = await rpc('ai_org_key', { p_org: q.org_id }, null).catch(() => null) as string | null;
  const apiKey = orgKey || Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    await finish('failed');
    return reply({ error: 'The help assistant isn\'t set up yet: no Anthropic API key. Ask an admin.' });
  }

  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  try {
    const response = await client.messages.create({
      model: q.model,
      max_tokens: q.max_tokens,
      // The guide is the same for every question, so it is cached and later questions read it at a tenth of the price.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: shaped.messages,
      ...modelOptions(q.model),
    });
    await finish('answered', response.usage);
    if (response.stop_reason === 'refusal') {
      return reply({ answer: 'I can\'t help with that one. Try asking how to do something in Oizer.', remaining: q.remaining });
    }
    const text = response.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map(c => c.text).join('\n').trim();
    const cut = response.stop_reason === 'max_tokens' ? '\n\n(The answer was cut short. Ask a narrower question.)' : '';
    return reply({ answer: (text || 'I don\'t have an answer for that.') + cut, remaining: q.remaining });
  } catch (e) {
    await finish('failed');
    if (e instanceof Anthropic.AuthenticationError) return reply({ error: 'The assistant\'s API key was refused. Ask an admin to check it.' });
    if (e instanceof Anthropic.RateLimitError) return reply({ error: 'The assistant is busy. Try again in a minute.' });
    if (e instanceof Anthropic.APIConnectionError) return reply({ error: 'The assistant couldn\'t be reached. Try again.' });
    if (e instanceof Anthropic.APIError) return reply({ error: `The assistant had a problem (${e.status ?? 'error'}). Try again later.` });
    return reply({ error: 'The assistant had a problem. Try again later.' });
  }
});
