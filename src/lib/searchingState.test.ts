import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #66 (2026-11-15): a searching state in the header search and the Campaign ID box; Suspend asks first.
describe('searching state and Suspend', () => {
  const l = readFileSync('src/components/Layout.tsx', 'utf8');
  it('shows Searching… in the header search and the Campaign ID box', () => {
    expect(l).toContain('{typing ? <span className="muted small search-busy" aria-live="polite">Searching…</span> : <span className="kbd">Ctrl K</span>}');
    expect(l).toContain('{jumpBusy && <li className="muted" aria-live="polite">Searching…</li>}');
  });
  it('asks before suspending an organization', () => {
    expect(readFileSync('src/pages/Platform.tsx', 'utf8')).toContain("if (status !== 'active' && !confirm(`Set ${o.name} to ${status}? Its people will lose access immediately.`)) return;");
  });
});
