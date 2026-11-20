import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sharpLogoUrl } from './sharpLogo';

const give = readFileSync('src/pages/Give.tsx', 'utf8');
const css = readFileSync('src/styles.css', 'utf8');

describe('payment page teams panel (Moshe Henig, 2026-11-11)', () => {
  it('is its own card, on the right on wide screens and above the form on a phone', () => {
    expect(give).toContain('<aside className="give-card give-teams" aria-label={t.teams}>');
    expect(give).toContain("<main className={`give-main ${teams.length ? 'has-teams' : ''}`}>");
    expect(give).toContain('href={`/give/${encodeURIComponent(tm.id)}`}');
    expect(css).toContain('.give-main.has-teams { grid-template-columns: minmax(0, 1fr) 300px;');
    expect(css).toContain('.give-main.has-teams > .give-teams { grid-column: 2;');
  });
});

describe('sharp banner logo (Moshe Henig, 2026-11-11)', () => {
  it('asks Google for a 256-pixel image instead of a 40-pixel one', () => {
    expect(sharpLogoUrl('https://lh3.googleusercontent.com/a-/ALV-abc=s40-p')).toBe('https://lh3.googleusercontent.com/a-/ALV-abc=s256-p');
    expect(sharpLogoUrl('https://lh3.googleusercontent.com/d/xyz=w100-h50')).toBe('https://lh3.googleusercontent.com/d/xyz=s256');
    expect(sharpLogoUrl('https://lh3.googleusercontent.com/d/xyz')).toBe('https://lh3.googleusercontent.com/d/xyz=s256');
    expect(sharpLogoUrl('https://example.org/logo.png')).toBe('https://example.org/logo.png');
    expect(sharpLogoUrl('')).toBeNull();
  });
  it('is never drawn larger than the image, with no white box behind it', () => {
    expect(give).toContain('<img src={sharpLogoUrl(data.org.logo_url)!} alt="" decoding="async" />');
    const rule = css.match(/\.give-org img \{[^}]*\}/)![0];
    expect(rule).toContain('height: auto;');
    expect(rule).toContain('max-height: 56px;');
    expect(rule).not.toContain('background');
  });
});
