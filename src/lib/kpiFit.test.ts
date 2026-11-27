import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitCenter } from '../components/MethodPie';

// Moshe Henig, 2026-11-15: on the dashboard, $4,549,228.19 and $3,642,517.99 ran out of their boxes, and the
// donut's $219,387.61 ran over the ring. Checked in a browser at 320-2560 px; these lock the rules in place.
const css = readFileSync('src/styles.css', 'utf8');

describe('dashboard boxes fit their amounts', () => {
  it('sizes the amount to the box, drops the text under the icon when narrow, and never lets it spill out', () => {
    expect(readFileSync('src/components/Kpi.tsx', 'utf8')).toContain('<div className="kpi-body">');
    // Trubase UI cards (2026-11-27): icon chip, label, figure, caption in a column. The sized text box is stretched to
    // the card's full width, so it never collapses to nothing (what an earlier column layout did).
    expect(css).toMatch(/\.kpi \{[^}]*flex-direction: column; gap: 4px; align-items: stretch; min-width: 0;/);
    expect(css).toContain('.kpi-body { width: 100%; min-width: 0; container-type: inline-size; overflow-wrap: anywhere;');
    // 28px figures, smaller only when the card is narrow; long amounts wrap rather than spill out.
    expect(css).toContain('font-size: clamp(18px, 12cqi, 28px);');
  });

  it('shrinks the donut centre total to fit inside the ring', () => {
    const hole = 100 - 14;   // the inner ring is 100 units across; 7 units of room each side
    for (const t of ['$219,387.61', '$4,549,228.19', '$45,549,228.19']) expect(fitCenter(t, 17) * 0.6 * t.length).toBeLessThanOrEqual(hole);
    expect(fitCenter('$505.00', 17)).toBe(17);   // short amounts keep the full size
    expect(fitCenter('total', 11)).toBe(11);
  });
});
