import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.');
}

// PKCE puts the email-link code in ?code= so it doesn't collide with HashRouter's #/ routes.
export const supabase = createClient(url, key, { auth: { flowType: 'pkce' } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

type PageQuery = (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;

/** PostgREST caps responses at 1000 rows; page through until everything is loaded. */
export async function fetchAll(query: PageQuery, pageSize = 1000): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}
