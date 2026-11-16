import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #26 (2026-11-15): a green or red Books health badge on the dashboard, from the nightly check.
describe('books health on the dashboard', () => {
  const d = readFileSync('src/pages/Dashboard.tsx', 'utf8');
  it('shows the latest check to admins, with what it found and Check now', () => {
    expect(d).toContain('{isAdmin && <BooksHealth />}');
    expect(d).toContain("supabase.from('integrity_runs').select('ran_at, ok, results').order('ran_at', { ascending: false }).limit(1)");
    expect(d).toContain("await supabase.rpc('check_books_now');");
    expect(d).toContain("className={`books-health ${run ? (run.ok ? 'ok' : 'bad') : ''}`}");
  });
  it('lists books-check findings on the Task Sheet', () => {
    expect(readFileSync('src/pages/TaskSheet.tsx', 'utf8')).toContain("integrity: { label: 'Books Check', tone: 'red' },");
  });
});
