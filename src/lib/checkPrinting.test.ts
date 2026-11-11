import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: printing a check never downloads a file, and asks whether it printed.
const checks = readFileSync('src/pages/Checks.tsx', 'utf8');
describe('check printing', () => {
  it('opens the PDF in a browser tab (or print preview), never as a download', () => {
    expect(checks).not.toMatch(/\.download\s*=/);
    expect(checks).toContain("const w = window.open('', '_blank');");
    expect(checks).toContain('if (tab && !tab.closed) tab.location.href = url;');
    expect(checks).toContain('else printInPage(url);');
    // Every print opens its tab before waiting on anything, so browsers don't block it.
    for (const fn of ['async function preview() {\n    if (!settings) return;\n    const tab = pdfTab();', 'async function issue() {\n    if (!settings) return;\n    const tab = pdfTab();',
      'export async function reprintCheck(checkId: string): Promise<{ id: string; number: number }> {\n  const tab = pdfTab();', 'async function testPrint() {\n    const tab = pdfTab();']) {
      expect(checks).toContain(fn);
    }
  });
  it('asks whether the check printed, and lists unprinted checks on the Task Sheet', () => {
    expect(checks).toContain('Did check #{check.number} print correctly?');
    expect(checks).toContain("supabase.rpc('mark_check_printed', { p_check: check.id })");
    const sheet = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
    expect(sheet).toContain("check_unprinted: { label: 'Check Not Printed', tone: 'amber' },");
    expect(sheet).toContain("{item.task_type === 'check_unprinted' && <UnprintedCheckTask checkId={item.record_id} onDone={onDone} />}");
  });
});

describe('check payouts to print (Moshe Henig, 2026-11-11)', () => {
  it('show as Check To Print on the Task Sheet, with the payout’s Print check right there', () => {
    const sheet = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
    expect(sheet).toContain("check_to_print: { label: 'Check To Print', tone: 'amber' },");
    expect(sheet).toContain("{item.task_type === 'check_to_print' && <PayoutPrintTask payoutId={item.record_id} onDone={onDone} />}");
    expect(checks).toContain('return <PayoutCheckActions record={payout} onDone={() => onDone()} />;');
  });
});
