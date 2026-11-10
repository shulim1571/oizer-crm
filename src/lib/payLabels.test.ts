import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: the payment page says "ACH", not "bank account", in every language, and its payment
// options sit on one row.
describe('payment page method labels', () => {
  it('call the bank option ACH in English, Hebrew and Yiddish', () => {
    const en = readFileSync('src/pages/PayMethods.tsx', 'utf8');
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(en).toMatch(/bank: 'ACH'/);
    expect([...give.matchAll(/\bbank: '([^']*)'/g)].map(m => m[1])).toEqual(['ACH', 'ACH']);
    expect(give).not.toMatch(/bank account|חשבון הבנק|באנק אקאונט וועט/i);
  });

  it('keep the payment options on one row', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.pay-methods \{[^}]*flex-wrap: nowrap/);
  });

  it('ask for the ZIP as required, and list no card brands', () => {
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(give).toMatch(/\{zipLabel\} \*<\/span><input required/);
    expect(give).not.toMatch(/give-logos|Mastercard|Discover/);
  });

  it('put card number, expiry and CVV on one line, in that order, and first and last name side by side', () => {
    const pay = readFileSync('src/pages/Payments.tsx', 'utf8');
    const fields = pay.slice(pay.indexOf('<div ref={box} className="card-fields">'));
    const at = (s: string) => fields.indexOf(s);
    expect(at('data-ifields-id="card-number"')).toBeLessThan(at('card-exp'));
    expect(at('card-exp')).toBeLessThan(at('data-ifields-id="cvv"'));
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.card-fields \{[^}]*grid-template-columns: minmax\(0, 1fr\) 96px 84px/);
    expect(css).not.toMatch(/\.card-fields \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(give).toMatch(/<div className="give-names wide">\s*<label[^]*?first_name[^]*?last_name[^]*?<\/div>/);
  });

  it('ask donors giving another way to include the campaign ID, in every language', () => {
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect([...give.matchAll(/include_id: '([^']+)'/g)].map(m => m[1]))
      .toEqual(['Make sure to include the campaign ID', 'הקפידו לציין את מספר הקמפיין', 'מאכט זיכער צו שרייבן די קאמפעין נומער']);
    const other = give.slice(give.indexOf('{t.other_ways}'), give.indexOf('</section>', give.indexOf('{t.other_ways}')));
    expect(other).toContain('{t.include_id}: <b>{c.id}</b>');
  });
});
