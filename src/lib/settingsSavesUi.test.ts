import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #62 (2026-11-15): one Save on the Organization page; My Notifications has no ticked-but-disabled switch
// and asks for the cell number when texts are chosen.
describe('settings saving', () => {
  const o = readFileSync('src/pages/Organization.tsx', 'utf8');
  it('saves the organization details with one Save, and the number settings on leaving the box', () => {
    expect(o).toContain('title="Organization details"');
    expect(o).toContain('fields={SECTIONS.flatMap(sec => sec.fields.map(f => ({ ...f, section: sec.title })))');
    expect(o).not.toContain('saveLabel={sec.save}');
    expect(o).toContain('onBlur={() => void save()}');
  });
  it('shows the notifications switch only once loaded, and asks for the cell number', () => {
    const n = readFileSync('src/pages/Notifications.tsx', 'utf8');
    expect(n).toContain("{q.loading ? <p className=\"muted\">Checking your notification settings…</p> : <>");
    expect(n).not.toContain('disabled={q.loading}');
    expect(n).toContain("Some notifications are set to come by text, but there's no cell number yet.");
  });
});
