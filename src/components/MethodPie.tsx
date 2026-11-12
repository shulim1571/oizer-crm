import { useMemo, useState } from 'react';
import { money } from '../lib/format';

// Donations by payment method, as a pie (Moshe Henig, 2026-11-11), beside Donations over time on the dashboard.
// At most six methods get their own slice; the rest are folded into "Other". Colors are the validated categorical
// palette in fixed order (CSS --series-1..6, light and dark), "Other" is neutral gray. Names, amounts and shares are
// always written in the legend, so color is never the only label.
export interface MethodTotal { name: string; total: number; count?: number }
const MAX_SLICES = 6;

export function pieSlices(rows: MethodTotal[]) {
  const sorted = [...rows].filter(r => Number(r.total) > 0).sort((a, b) => Number(b.total) - Number(a.total));
  const head = sorted.length > MAX_SLICES ? sorted.slice(0, MAX_SLICES - 1) : sorted;
  const rest = sorted.slice(head.length);
  const slices = head.map((r, i) => ({ name: r.name, total: Number(r.total), color: `var(--series-${i + 1})` }));
  if (rest.length) slices.push({ name: `Other (${rest.length})`, total: rest.reduce((s, r) => s + Number(r.total), 0), color: 'var(--series-other)' });
  const sum = slices.reduce((s, x) => s + x.total, 0);
  return { sum, slices: slices.map(x => ({ ...x, share: sum ? x.total / sum : 0 })) };
}

const R = 80, INNER = 50, C = 100;
function arc(start: number, end: number) {
  const p = (a: number, r: number) => [C + r * Math.sin(a), C - r * Math.cos(a)];
  if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4;   // a single method: a full ring
  const large = end - start > Math.PI ? 1 : 0;
  const [x1, y1] = p(start, R), [x2, y2] = p(end, R), [x3, y3] = p(end, INNER), [x4, y4] = p(start, INNER);
  return `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${INNER},${INNER} 0 ${large} 0 ${x4},${y4} Z`;
}

export default function MethodPie({ methods }: { methods: MethodTotal[] }) {
  const { sum, slices } = useMemo(() => pieSlices(methods), [methods]);
  const [hover, setHover] = useState<number | null>(null);
  const pct = (s: number) => `${Math.round(s * 1000) / 10}%`;
  let at = 0;
  const shapes = slices.map(s => { const start = at; at += s.share * Math.PI * 2; return { ...s, d: arc(start, at) }; });
  const h = hover !== null ? slices[hover] : null;
  return (
    <div className="card method-pie">
      <h3>By payment method</h3>
      {slices.length === 0 ? <p className="muted">No donations in this period</p> : (
        <div className="method-pie-body">
          <svg viewBox="0 0 200 200" role="img" aria-label={`Donations by payment method: ${slices.map(s => `${s.name} ${pct(s.share)}`).join(', ')}`}>
            {shapes.map((s, i) => (
              <path key={s.name} d={s.d} fill={s.color} className={hover === null || hover === i ? '' : 'dim'}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <title>{`${s.name}: ${money(s.total)} (${pct(s.share)})`}</title>
              </path>
            ))}
            <text x={C} y={C - 4} textAnchor="middle" className="pie-center-value">{h ? pct(h.share) : money(sum)}</text>
            <text x={C} y={C + 14} textAnchor="middle" className="pie-center-label">{h ? h.name : 'total'}</text>
          </svg>
          <table className="mini pie-legend"><tbody>
            {slices.map((s, i) => (
              <tr key={s.name} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <td><span className="swatch" style={{ background: s.color }} />{s.name}</td>
                <td className="right num">{money(s.total)}</td>
                <td className="right num muted">{pct(s.share)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}
