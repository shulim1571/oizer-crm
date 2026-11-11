import { describe, expect, it } from 'vitest';
import { MICR_BASELINE_ABOVE_BOTTOM, MICR_CHAR_HEIGHT_IN, SIGNATURE_BOX, micrLine } from './checkPdf';
import { inkBox } from './signatureTrim';

// Moshe Henig, 2026-11-11: larger MICR numbers moved up slightly, the account number closer to the routing number,
// and a slightly larger signature sitting on the signature line.
describe('check layout', () => {
  it('prints the MICR line at the standard 0.117 inch height and a little higher, at the same 1/8 inch pitch', () => {
    expect(MICR_CHAR_HEIGHT_IN).toBe(0.117);
    expect(MICR_BASELINE_ABOVE_BOTTOM).toBe(18);            // 1/4 inch, was 3/16
    expect(MICR_BASELINE_ABOVE_BOTTOM).toBeLessThan(45);     // inside the bottom 5/8 inch band
  });

  it('puts the account number one space from the routing number', () => {
    const line = micrLine(1042, '021000021', '123456789');
    const pos = (ch: string, from = 0) => line.filter(m => m.char === ch).map(m => m.position).sort((a, b) => b - a)[from];
    const routingRight = Math.min(...line.filter(m => m.position >= 33 && m.position <= 43).map(m => m.position));
    const accountLeft = Math.max(...line.filter(m => m.position < 33).map(m => m.position));
    expect(routingRight).toBe(33);
    expect(accountLeft).toBe(31);                              // position 32 is the one space between
    expect(pos('C', 2)).toBe(22);                              // the on-us symbol ends the account field
    // A very long account number still ends no further right than position 14.
    const long = micrLine(1, '021000021', '123456789012345678');
    expect(Math.min(...long.map(m => m.position))).toBe(14);
  });

  it('sizes the signature by its writing and sets it on the line', () => {
    expect(SIGNATURE_BOX.bottom).toBeLessThan(598);            // just under the line at 598
    expect(SIGNATURE_BOX.bottom).toBeGreaterThan(593);         // clear of the AUTHORIZED SIGNATURE label
    // 4x3 image, transparent except ink at (1,1) and (2,2)
    const px = new Uint8ClampedArray(4 * 3 * 4);
    for (const [x, y] of [[1, 1], [2, 2]]) px.set([0, 0, 0, 255], (y * 4 + x) * 4);
    expect(inkBox(px, 4, 3)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(inkBox(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
