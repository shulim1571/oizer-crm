/** Alphabetical by what's shown, ignoring case, with numbers in natural order (Moshe Henig, 2026-11-11). */
export const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
