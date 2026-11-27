import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveRefresh, type LiveTopic } from './live';

/**
 * Tiny async loader: returns data, error, loading and a reload function.
 * `live`: topics that make it reload quietly by itself when they change in the database (live refresh, see lib/live).
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], opts?: { live?: LiveTopic[] }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  // Only the latest request may set the data: an older one finishing late (a previous date range, say) is ignored
  // (readiness #40: the Transactions summary could show the previous range's totals).
  const latest = useRef(0);

  // A quiet reload (quiet: true) keeps what's on screen while the fresh data loads: no loading state, no flash,
  // the scroll position and anything being typed stay put (Moshe Henig, 2026-11-12).
  const reload = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = !!(opts && typeof opts === 'object' && 'quiet' in opts && opts.quiet);
    const mine = ++latest.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await run();
      if (mine === latest.current) setData(result);
    } catch (e) {
      // A quiet refresh that fails leaves the rows already shown in place.
      if (!quiet && mine === latest.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefresh(opts?.live ?? [], () => void reload({ quiet: true }), !!opts?.live?.length);

  return { data, error, loading, reload, setData };
}
