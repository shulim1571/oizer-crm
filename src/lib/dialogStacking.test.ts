import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: editing a voucher opened the form underneath the voucher window.
describe('form dialogs', () => {
  it('are drawn at the end of the page, so one opened from another window is on top', () => {
    const form = readFileSync('src/components/RecordForm.tsx', 'utf8');
    expect(form).toContain('return createPortal(\n    <div className="modal-back"');
    expect(form).toContain('document.body,\n  );');
  });
});
