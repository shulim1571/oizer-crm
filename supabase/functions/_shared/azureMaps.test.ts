import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanQuery, formatSuggestion, searchParams, toSuggestions } from './azureMaps.ts';

// Azure Maps Search Address (api-version 1.0), US only, typeahead (Shulim, 2026-11-25). Sample data only.
const sample = {
  results: [
    { type: 'Point Address', address: { streetNumber: '123', streetName: 'Sample St', municipality: 'New York', municipalitySubdivision: 'Brooklyn', localName: 'Brooklyn', countrySubdivision: 'NY', countrySubdivisionCode: 'NY', postalCode: '11219', countryCode: 'US' } },
    { type: 'Point Address', address: { streetNumber: '123', streetName: 'Sample St', localName: 'Brooklyn', countrySubdivisionCode: 'NY', postalCode: '11219', countryCode: 'US' } },   // a repeat
    { type: 'Street', address: { streetName: 'Sample Ave', municipality: 'Lakewood, Lakewood Township', countrySubdivision: 'NJ', postalCode: '08701', countryCode: 'US' } },
    { type: 'Geography', address: { municipality: 'Brooklyn', countrySubdivision: 'NY', countryCode: 'US' } },   // a whole place
    { type: 'Point Address', address: { streetNumber: '1', streetName: 'Sample Rd', municipality: 'Toronto', countrySubdivision: 'ON', postalCode: 'M5V 1A1', countryCode: 'CA' } },
    { type: 'Point Address', address: { streetNumber: '9', streetName: 'Sample Ln', localName: 'Monsey', countrySubdivision: 'NY', postalCode: '109521234', countryCode: 'US' } },
  ],
};

describe('Azure Maps address suggestions', () => {
  it('looks up only 3 to 120 characters', () => {
    expect(cleanQuery('12')).toBeNull();
    expect(cleanQuery('  123  ')).toBe('123');
    expect(cleanQuery('123   Sample    St')).toBe('123 Sample St');
    expect(cleanQuery('x'.repeat(121))).toBeNull();
    expect(cleanQuery(42)).toBeNull();
  });

  it('asks Search Address 1.0 with typeahead, US only, and never puts the key in what it builds', () => {
    const p = searchParams('123 Sample St');
    expect(Object.fromEntries(p)).toEqual({ 'api-version': '1.0', query: '123 Sample St', typeahead: 'true', countrySet: 'US', limit: '8', language: 'en-US' });
    expect(p.has('subscription-key')).toBe(false);
  });

  it('keeps US street addresses with street, city, state and ZIP, without repeats or whole places', () => {
    expect(toSuggestions(sample)).toEqual([
      { street: '123 Sample St', city: 'Brooklyn', state: 'NY', zip: '11219', one_line: '123 Sample St, Brooklyn NY 11219', two_lines: '123 Sample St\nBrooklyn NY 11219' },
      { street: 'Sample Ave', city: 'Lakewood', state: 'NJ', zip: '08701', one_line: 'Sample Ave, Lakewood NJ 08701', two_lines: 'Sample Ave\nLakewood NJ 08701' },
      { street: '9 Sample Ln', city: 'Monsey', state: 'NY', zip: '10952', one_line: '9 Sample Ln, Monsey NY 10952', two_lines: '9 Sample Ln\nMonsey NY 10952' },
    ]);
    expect(toSuggestions(null)).toEqual([]);
    expect(toSuggestions({ results: 'x' })).toEqual([]);
  });

  it('formats like the USPS check\'s "Use this"', () => {
    expect(formatSuggestion({ street: '1 A St', city: 'Brooklyn', state: 'NY', zip: '11219' }, true)).toBe('1 A St, Brooklyn NY 11219');
  });

  it('the function requires sign-in, books each lookup in the database first, and never logs or returns the key', () => {
    const src = readFileSync('supabase/functions/address-suggest/index.ts', 'utf8');
    expect(src).toContain("if (!token) return reply({ error: 'Sign in to look up addresses' }, 401);");
    expect(src.indexOf('await begin(token, b.org)')).toBeLessThan(src.indexOf("Deno.env.get('AZURE_MAPS_KEY')"));
    expect(src).not.toMatch(/console\.\w+\([^)]*(key|params|AZURE_SEARCH_ADDRESS)/);
    expect(src).not.toMatch(/reply\([^)]*key/);
    expect(src).toContain("import { apiHeaders } from '../_shared/keys.ts';");
  });
});
