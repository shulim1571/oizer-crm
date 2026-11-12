import { describe, expect, it } from 'vitest';
import { MAKE_SOURCES as FN_SOURCES, KEY_HEADER } from '../../supabase/functions/_shared/makeIngest';
import { MAKE_HEADER, MAKE_SOURCES, makeUrl } from './MakeIngest';

// The settings page lists exactly the sources the make-ingest function accepts, with the same header.
describe('Make ingest addresses', () => {
  it('match the function', () => {
    expect(MAKE_SOURCES.map(s => s.value)).toEqual([...FN_SOURCES]);
    expect(MAKE_HEADER).toBe(KEY_HEADER);
    const u = new URL(makeUrl('00000000-0000-4000-8000-000000000001', 'sola'), 'https://x');
    expect(u.pathname).toMatch(/\/functions\/v1\/make-ingest$/);
    expect(Object.fromEntries(u.searchParams)).toEqual({ org: '00000000-0000-4000-8000-000000000001', source: 'sola' });
  });
});
