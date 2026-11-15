import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #5 (2026-11-15): on a phone (360-414 px) the public payment page's sticky Donate bar covered whichever
// field sat at the bottom of the screen, including the one being typed in above the keyboard. Desktop layout is
// held (#44) and left as it was.
const css = readFileSync('src/styles.css', 'utf8');
const rules = (sel: string) => [...css.matchAll(new RegExp(`(^|\\n)\\s*${sel.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[2]);

describe('payment page on phones', () => {
  it('puts the Donate button after the last field instead of over the fields', () => {
    const base = rules('.give-submit-bar');
    expect(base.length).toBeGreaterThan(0);
    for (const r of base) expect(r).not.toMatch(/position:\s*(sticky|fixed)/);
  });

  it('keeps every card field in view at 360 px: the card number shrinks, expiry and CVV keep a fixed width', () => {
    expect(css).toMatch(/@media \(max-width: 600px\) \{ \.card-fields \{ grid-template-columns: minmax\(0, 1fr\) 80px 64px;/);
    // 360 px screen - 24 px page gutters - 36 px card padding - 2 x 6 px gaps - 80 - 64 = 144 px for the card number.
    expect(360 - 24 - 36 - 12 - 80 - 64).toBeGreaterThanOrEqual(140);
  });

  it('leaves the desktop layout as it was (held, #44)', () => {
    expect(css).toContain('.give-submit-bar { position: static; background: none; margin: 12px 0 0; padding: 0; }');
    expect(css).toContain('.give-form-card { position: sticky; top: 16px; align-self: start; }');
  });
});
