/**
 * A logo address asking for a sharp image (Moshe Henig, 2026-11-11: the banner logo looked blurry). Google profile
 * and Drive images are served at the size named in the address ("=s40-p" is 40 pixels), far too small for the
 * banner, so ask for 256 pixels instead. Other addresses are used as they are.
 */
export function sharpLogoUrl(url: string | null | undefined, size = 256): string | null {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (!/^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//i.test(u)) return u;
  if (/=s\d+(-[a-z0-9-]+)?$/i.test(u)) return u.replace(/=s\d+((?:-[a-z0-9-]+)?)$/i, `=s${size}$1`);
  if (/=w\d+-h\d+(-[a-z0-9-]+)?$/i.test(u)) return u.replace(/=w\d+-h\d+((?:-[a-z0-9-]+)?)$/i, `=s${size}$1`);
  return /=[a-z0-9-]+$/i.test(u) ? u : `${u}=s${size}`;
}
