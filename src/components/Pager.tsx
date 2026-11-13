/**
 * Previous / numbered pages / Next. With many pages it shows the first and last, the current one and two on
 * each side, and … for the gaps: 1 … 4 5 [6] 7 8 … 42 (Moshe Henig, 2026-11-10).
 */
export function pageItems(current: number, total: number, around = 2): (number | '…')[] {
  if (total <= 1) return [1];
  const keep = new Set<number>([1, total]);
  for (let p = current - around; p <= current + around; p++) if (p >= 1 && p <= total) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0) {
      const gap = p - sorted[i - 1];
      if (gap === 2) out.push(p - 1);       // a gap of one page shows the page, not …
      else if (gap > 2) out.push('…');
    }
    out.push(p);
  });
  return out;
}

/** `page` is zero-based, as the lists keep it. */
export default function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const total = Math.max(pages, 1);
  return (
    <nav className="pager" aria-label="Pages">
      <button type="button" className="btn" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
      {pageItems(page + 1, total).map((p, i) => p === '…'
        ? <span key={`gap${i}`} className="pager-gap" aria-hidden="true">…</span>
        : <button type="button" key={p} className={`btn pager-num ${p === page + 1 ? 'on' : ''}`} aria-current={p === page + 1 ? 'page' : undefined}
            aria-label={`Page ${p}`} onClick={() => onPage(p - 1)}>{p}</button>)}
      <button type="button" className="btn" disabled={page + 1 >= total} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}
