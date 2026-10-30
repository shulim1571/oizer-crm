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

/**
 * PostgREST caps responses at 1000 rows; page through until everything is loaded.
 * After the first page, requests go out a few at a time in parallel.
 */
export async function fetchAll(query: PageQuery, pageSize = 1000, parallel = 4): Promise<Row[]> {
  const page = async (n: number) => {
    const { data, error } = await query(n * pageSize, (n + 1) * pageSize - 1);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  const rows = await page(0);
  if (rows.length < pageSize) return rows;
  for (let next = 1; ; next += parallel) {
    const batch = await Promise.all(Array.from({ length: parallel }, (_, i) => page(next + i)));
    for (const b of batch) rows.push(...b);
    if (batch.some(b => b.length < pageSize)) return rows;
  }
}
