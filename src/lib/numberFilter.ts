/** ">100", "<=5", "10-20" or a plain number, as bounds. Returns null when it isn't numeric. */
export function parseNumberFilter(text: string): { min?: number; max?: number; minOpen?: boolean; maxOpen?: boolean } | null {
  const t = text.trim();
  const op = t.match(/^(>=|<=|>|<|=)\s*(-?[\d,.]+)$/);
  const num = (s: string) => Number(s.replace(/,/g, ''));
  if (op) {
    const n = num(op[2]);
    if (isNaN(n)) return null;
    if (op[1] === '>') return { min: n, minOpen: true };
    if (op[1] === '>=') return { min: n };
    if (op[1] === '<') return { max: n, maxOpen: true };
    if (op[1] === '<=') return { max: n };
    return { min: n, max: n };
  }
  const range = t.match(/^(-?[\d,.]+)\s*-\s*(-?[\d,.]+)$/);
  if (range) return { min: num(range[1]), max: num(range[2]) };
  const n = num(t);
  return t && !isNaN(n) ? { min: n, max: n } : null;
}

/**
 * The From and To boxes of a number filter (Moshe Henig, 2026-11-11), kept as the same text a typed filter uses:
 * both ends "10-20", only From ">=10", only To "<=20", neither "". Either end can be left blank.
 */
export function rangeText(from: string, to: string): string {
  const f = from.trim(), t = to.trim();
  if (f && t) return `${f}-${t}`;
  if (f) return `>=${f}`;
  if (t) return `<=${t}`;
  return '';
}

/** The From and To shown for a saved number filter (an old ">100" shows as From 100). */
export function rangeEnds(text: string | undefined): { from: string; to: string } {
  const b = text ? parseNumberFilter(text) : null;
  return { from: b?.min != null ? String(b.min) : '', to: b?.max != null ? String(b.max) : '' };
}

