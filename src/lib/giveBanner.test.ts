import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Payment page banner (Moshe Henig, 2026-11-11): email and phone on the right, a bigger logo.
describe('payment page banner', () => {
  const give = readFileSync('src/pages/Give.tsx', 'utf8');
  const css = readFileSync('src/styles.css', 'utf8');
  it('puts the organization and its email and phone on one row, the contact at the far side', () => {
    const top = give.slice(give.indexOf('<div className="give-hero-top">'), give.indexOf('<h1 dir="auto">{c.name}</h1>'));
    expect(top).toContain('<div className="give-org">');
    expect(top).toContain('<OrgContact email={data.org.email} phone={data.org.phone}');
    expect(css).toContain('.give-hero-top { display: flex; align-items: center; justify-content: space-between;');
    expect(css).toContain('.give-hero-top .give-contact { margin-inline-start: auto;');
  });
  it('shows a bigger logo', () => {
    expect(css).toContain('.give-org img { height: 56px;');
    expect(css).toContain('.give-org-mark { width: 48px; height: 48px;');
  });
});
