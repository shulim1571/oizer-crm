import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('fundraiser calendar screens (Moshe Henig, 2026-11-11)', () => {
  it('is open to fundraisers, without admin details', () => {
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="calendar" element={<Suspense fallback={null}><CalendarPage /></Suspense>} />');
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain("tabs: [{ to: '/calendar', label: 'Calendar' }, { to: '/machines', label: 'Bookings' }] },");
    const cal = readFileSync('src/pages/Calendar.tsx', 'utf8');
    expect(cal).toContain('{!past && isAdmin && <BookingActions');
    expect(cal).toContain("isAdmin\n        ? supabase.from('expenses')");
  });
});
