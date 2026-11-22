// Sola's card fields (iFields), loaded from Sola's servers. One place for the version and address.

export const IFIELDS_VERSION = '3.5.2607.1401';
export const IFIELDS = `https://cdn.cardknox.com/ifields/${IFIELDS_VERSION}`;

let warmed = false;
/**
 * Starts the work for Sola's card fields early (Shulim, 2026-11-22), so it overlaps with loading the page's own data:
 * opens the connection to Sola's server and downloads its script into the cache. Running the script, and creating the
 * card iframes, still happen when the card fields appear (they need to run fresh then); this only removes the wait
 * for the network. Safe to call more than once.
 */
export function warmIfields() {
  if (warmed || typeof document === 'undefined') return;
  warmed = true;
  const add = (attrs: Record<string, string>) => {
    const l = document.createElement('link');
    for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v);
    document.head.appendChild(l);
  };
  add({ rel: 'preconnect', href: 'https://cdn.cardknox.com' });
  add({ rel: 'preload', as: 'script', href: `${IFIELDS}/ifields.min.js` });
}
