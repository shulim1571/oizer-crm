import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanQuery, formatSuggestion, readRegion, searchParams, toSuggestions } from './azureMaps.ts';

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

  it('formats in the one-field address layout', () => {
    expect(formatSuggestion({ street: '1 A St', city: 'Brooklyn', state: 'NY', zip: '11219' }, true)).toBe('1 A St, Brooklyn NY 11219');
  });

  it('the function requires sign-in (except from a payment page), books each lookup first, and never logs or returns the key', () => {
    const src = readFileSync('supabase/functions/address-suggest/index.ts', 'utf8');
    expect(src).toContain("} else if (!token) {\n    return reply({ error: 'Sign in to look up addresses' }, 401);");
    // A payment page must name a campaign (and a real organization id); its lookups are booked with the server key.
    expect(src).toContain('const fromPage = b.campaign !== undefined;');
    expect(src).toContain("/^[A-Za-z0-9-]{1,40}$/.test(b.campaign) || !/^[0-9a-f-]{36}$/i.test(b.org)");
    expect(src).toContain('rpc/address_suggest_public_begin');
    // The connection is only ever a keyed hash; its address is never logged or sent on.
    expect(src).toContain("crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }");
    expect(src).not.toMatch(/console\.\w+\([^)]*\bip\b/);
    expect(src).not.toMatch(/p_ip_hash: ip\b/);
    // Each lookup is booked (as the person, or for a payment page) before Azure is asked.
    expect(src.indexOf('await begin(token, b.org)')).toBeLessThan(src.indexOf('await fetch(`${AZURE_SEARCH_ADDRESS}'));
    expect(src.indexOf('await beginPublic(')).toBeLessThan(src.indexOf('await fetch(`${AZURE_SEARCH_ADDRESS}'));
    expect(src).not.toMatch(/console\.\w+\([^)]*(key|params|AZURE_SEARCH_ADDRESS)/);
    expect(src).not.toMatch(/reply\([^)]*key/);
    expect(src).toContain("import { apiHeaders } from '../_shared/keys.ts';");
  });

  // An organization's region (Shulim, 2026-11-25): only these states, or these first.
  it('reads the region setting: known states only, off when none', () => {
    expect(readRegion({ mode: 'only', states: ['ny', 'NJ', 'XX', 'NY'] })).toEqual({ mode: 'only', states: ['NY', 'NJ'] });
    expect(readRegion({ mode: 'prefer', states: ['CT'] })).toEqual({ mode: 'prefer', states: ['CT'] });
    expect(readRegion({ mode: 'off', states: ['NY'] })).toBeNull();
    expect(readRegion({ mode: 'only', states: ['XX'] })).toBeNull();
    expect(readRegion(null)).toBeNull();
  });

  it('points Azure at the region\'s first state and asks for more when a region is set', () => {
    const p = searchParams('123 Sample St', { mode: 'prefer', states: ['NJ', 'NY'] });
    expect([p.get('lat'), p.get('lon'), p.get('limit'), p.get('countrySet')]).toEqual(['40.2', '-74.7', '20', 'US']);
    expect(searchParams('123 Sample St').has('lat')).toBe(false);
  });

  it('shows only the region\'s addresses, or the region\'s first', () => {
    expect(toSuggestions(sample, { mode: 'only', states: ['NJ'] }).map(s => s.state)).toEqual(['NJ']);
    expect(toSuggestions(sample, { mode: 'prefer', states: ['NJ'] }).map(s => s.state)).toEqual(['NJ', 'NY', 'NY']);
    expect(toSuggestions(sample, { mode: 'only', states: ['CA'] })).toEqual([]);
  });

  it('the function reads the organization\'s region after the access check, and narrows with it', () => {
    const src = readFileSync('supabase/functions/address-suggest/index.ts', 'utf8');
    expect(src.indexOf('const refused = fromPage')).toBeLessThan(src.indexOf('const region = await orgRegion(b.org)'));
    expect(src).toContain('searchParams(query, region)');
    expect(src).toContain('toSuggestions(await res.json().catch(() => null), region)');
    expect(src).toContain('key=eq.address_region');
  });
});
