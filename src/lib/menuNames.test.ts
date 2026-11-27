import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, #65 (2026-11-15): the sidebar says "Task Sheet"; the Machine Bookings tabs get clearer names.
describe('menu and tab names', () => {
  const l = readFileSync('src/components/Layout.tsx', 'utf8');
  it('says Task Sheet in the sidebar for admins (fundraisers, who have Campaign Tasks only, keep Tasks)', () => {
    expect(l).toContain("{ to: '/task-sheet', label: 'Tasks', adminLabel: 'Task Sheet', icon: <ListChecks size={I} />, badge: 'tasks',");
    expect(l).toContain('const MENU = NAV.map(sec => ({ ...sec, items: sec.items.map(n => (isAdmin && n.adminLabel ? { ...n, label: n.adminLabel } : n)) }));');
    expect(l).toContain('{MENU.map(section => {');
  });
  it('names the Machine Bookings tabs Booking calendar and All bookings', () => {
    expect(l).toContain("{ to: '/calendar', label: 'Booking calendar' }, { to: '/machines', label: 'All bookings' }");
    expect(l).not.toContain("label: 'Calendar' }");
  });
});
