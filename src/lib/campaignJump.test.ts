import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
const { cleanJump, rank } = await import('./campaignJump');

// Moshe Henig, 2026-11-12: typing a campaign's number (3040) finds AS-3040, exact IDs win, then the rest by ID.
describe('Campaign ID box', () => {
  it('ranks the exact ID first, then the number without its prefix, then the rest in number order', () => {
    const rows = [{ id: 'AS-30401' }, { id: 'AS-3040' }, { id: '3040' }, { id: 'AS-1304' }];
    expect(rank(rows, '3040').map(r => r.id)).toEqual(['3040', 'AS-3040', 'AS-1304', 'AS-30401']);
    expect(rank([{ id: 'as-3040' }, { id: 'AS-3040X' }], 'AS-3040').map(r => r.id)).toEqual(['as-3040', 'AS-3040X']);
  });
  it('drops characters that would break the search', () => {
    expect(cleanJump(' 30,40 (x)* ')).toBe('30 40 x');
    expect(cleanJump('   ')).toBe('');
  });
});
