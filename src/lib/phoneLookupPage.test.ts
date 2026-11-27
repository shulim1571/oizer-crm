import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shulim, 2026-11-10: the Leave out Donary setting sits with the text and phone reply switches and is saved with them.
describe('Phone & Text Lookup settings', () => {
  const src = readFileSync('src/pages/PhoneLookup.tsx', 'utf8');
  it('has the Leave out Donary switch next to the reply switches, saved with them', () => {
    expect(src).toMatch(/Answer the phone line[^]*Leave out Donary donations/);
    expect(src).toContain('p_exclude_donary: v.noDonary');
    expect(src).toContain('noDonary: !!s.exclude_donary');
  });
  it('explains RECENT and labels its log entries', () => {
    expect(src).toContain('<code>RECENT</code>');
    for (const k of ['recent', 'recent_limited', 'recent_unknown']) expect(src).toMatch(new RegExp(`${k}: \\{ tone`));
  });
});
