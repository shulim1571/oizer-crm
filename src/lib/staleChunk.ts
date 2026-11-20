// After a deploy, a page opened earlier asks for code files that no longer exist (Cloudflare Pages answers with the
// app's HTML instead), so anything loaded on demand, such as the check printer, fails to load. This recognizes that
// failure so screens can say "reload" instead of failing silently.

export function isStaleChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Expected a JavaScript.*module|MIME type of "text\/html"|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

export const STALE_MESSAGE = 'This page is out of date: the app was updated since it was opened. Reload the page and try again.';

/** A plain message for a failure, with the reload advice when the page is out of date. */
export function friendlyError(e: unknown): string {
  if (isStaleChunkError(e)) return STALE_MESSAGE;
  return e instanceof Error ? e.message : String(e);
}
