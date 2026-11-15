// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import SearchSelect from '../components/SearchSelect';
import { donorSearch } from './Donors';

// Moshe Henig, 2026-11-15: a last-name search on Donors showed only part of the matches, no way further, and the
// whole list still showed under the results. Now one list, searched on the server, every match, page by page.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const recorder = () => { const ors: string[] = []; const q = { or: (s: string) => { ors.push(s); return q; } }; return { q, ors }; };

describe('Donors list search', () => {
  it('asks the server for donors where every word matches a name, email or ID', () => {
    const { q, ors } = recorder();
    donorSearch(q, '  Horowitz  Moshe ', null);
    expect(ors).toEqual([
      'display_name.ilike.*Horowitz*,yiddish_name.ilike.*Horowitz*,email.ilike.*Horowitz*,id.ilike.Horowitz',
      'display_name.ilike.*Moshe*,yiddish_name.ilike.*Moshe*,email.ilike.*Moshe*,id.ilike.Moshe',
    ]);
  });

  it('also matches donors found by phone digits, and keeps characters that would break the query out', () => {
    const one = recorder();
    donorSearch(one.q, '7185550100', ['D-7']);
    expect(one.ors).toEqual(['display_name.ilike.*7185550100*,yiddish_name.ilike.*7185550100*,email.ilike.*7185550100*,id.ilike.7185550100,id.in.("D-7")']);
    const spaced = recorder();
    donorSearch(spaced.q, '718 555 0100', ['D-7']);
    expect(spaced.ors).toHaveLength(1);
    expect(spaced.ors[0]).toMatch(/^and\(or\(display_name\.ilike\.\*718\*.*\),id\.in\.\("D-7"\)$/);
    const odd = recorder();
    donorSearch(odd.q, 'a,b (c)*', null);
    expect(odd.ors.map(s => s.split(',')[0])).toEqual(['display_name.ilike.*a*', 'display_name.ilike.*b*', 'display_name.ilike.*c*']);
    const none = recorder();
    donorSearch(none.q, '   ', null);
    expect(none.ors).toEqual([]);
  });

  it('is one list paged on the server: no capped lookup and no second list under it', () => {
    const src = readFileSync('src/pages/Donors.tsx', 'utf8');
    expect(src).toContain("supabase.from('donor_summary').select('*', { count: 'exact' })");
    expect(src).toContain('.range(page * size, page * size + size - 1)');
    expect(src).toContain('<Pager page={page} pages={pages} onPage={setPage} />');
    expect(src).toContain('serverSearch');
    expect(src).not.toContain('DonorLookup');
    expect(src).not.toMatch(/fetchAll\(\(a, b\) => supabase\.from\('donor_summary'\)\.select\('\*'\)\.order\('total_given'/);
    expect(readFileSync('src/pages/DonorExtras.tsx', 'utf8')).not.toContain('function DonorLookup');
  });
});

describe('donor pickers', () => {
  const mount = (options: { value: string; label: string }[], type: string) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SearchSelect value={null} options={options} onChange={vi.fn()} />));
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, type);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focus'));
    });
    const items = [...host.querySelectorAll('.ss-list li')].map(li => li.textContent ?? '');
    act(() => root.unmount());
    host.remove();
    return items;
  };

  it('finds a name in either order, and a phone by its digits', () => {
    const opts = [{ value: '1', label: 'Moshe Horowitz · (718) 555-0100' }, { value: '2', label: 'Yosef Horowitz' }];
    expect(mount(opts, 'horowitz moshe').filter(t => t.includes('Horowitz'))).toEqual(['Moshe Horowitz · (718) 555-0100']);
    expect(mount(opts, '7185550100').filter(t => t.includes('Horowitz'))).toEqual(['Moshe Horowitz · (718) 555-0100']);
  });

  it('says how many more match instead of leaving them out silently', () => {
    const opts = Array.from({ length: 130 }, (_, i) => ({ value: String(i), label: `Donor Horowitz ${i}` }));
    const items = mount(opts, 'horowitz');
    expect(items.filter(t => t.startsWith('Donor Horowitz'))).toHaveLength(100);
    expect(items).toContain('30 more match. Keep typing to narrow the list.');
  });
});
