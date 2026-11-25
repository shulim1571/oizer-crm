import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe, 2026-11-25: on the payment page banner, the name and logo a little further in, and the phone above the email.
describe('payment page banner', () => {
  it('lists the phone first, then the email', () => {
    const c = readFileSync('src/components/OrgContact.tsx', 'utf8');
    expect(c.indexOf('href={`tel:')).toBeLessThan(c.indexOf('href={`mailto:'));
  });
  it('stacks them at the far edge, and moves the name and logo in from the edge', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain('.give-hero-top .give-contact { flex-direction: column; align-items: flex-end; gap: 4px; }');
    expect(css).toContain('.give-hero-top .give-org, .give-hero h1 { margin-inline-start: clamp(10px, 3vw, 36px); }');
  });
});
