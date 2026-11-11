import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { MICR_CHAR_HEIGHT_IN, MICR_SIZE, micrSizeFor } from './checkPdf';

// Moshe Henig, 2026-11-11: MICR digits at the standard E-13B height, 0.117 inch, measured from the font itself.
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
describe('MICR size', () => {
  it.skipIf(!existsSync(FONT))('makes the font’s digits 0.117 inch tall', () => {
    const bytes = new Uint8Array(readFileSync(FONT));
    const size = micrSizeFor(bytes);
    const f = (fontkit as any).create(bytes);
    const tallest = Math.max(...[...'0123456789'].map(ch => { const b = f.glyphForCodePoint(ch.charCodeAt(0)).bbox; return b.maxY - b.minY; }));
    expect((tallest / f.unitsPerEm) * size / 72).toBeCloseTo(MICR_CHAR_HEIGHT_IN, 3);
  });
  it('falls back to a standard size when there is no font or it can’t be read', () => {
    expect(micrSizeFor(null)).toBe(MICR_SIZE);
    expect(micrSizeFor(new Uint8Array([1, 2, 3]))).toBe(MICR_SIZE);
  });
});
