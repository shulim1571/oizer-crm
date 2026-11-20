import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donorFields } from './schemas';

// Moshe, Nov 16: donors have separate Cell and Home phone boxes.
describe('donor cell and home phones', () => {
  it('asks for Cell phone and Home phone instead of one Phone', () => {
    const names = donorFields.map(f => f.name);
    expect(names).toContain('cell_phone');
    expect(names).toContain('home_phone');
    expect(names).not.toContain('phone');
  });
  it('shows both on the donor list and the donor page', () => {
    const src = readFileSync('src/pages/Donors.tsx', 'utf8');
    expect(src).toContain("key: 'cell_phone', label: 'Cell'");
    expect(src).toContain("key: 'home_phone', label: 'Home'");
    expect(src).toContain('<dt>Cell</dt><dd>{formatPhone(d.cell_phone)');
    expect(src).toContain('<dt>Home</dt><dd>{formatPhone(d.home_phone)');
  });
});
