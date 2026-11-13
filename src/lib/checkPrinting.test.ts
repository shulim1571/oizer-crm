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

describe('after every check print (Moshe Henig, 2026-11-11: "didn’t ask me afterwards")', () => {
  it('asks whether it printed before the payout or the task closes', () => {
    expect(checks).toContain('onIssued={check => { setPrinting(false); setAsking(check); setVersion(v => v + 1); }}');
    expect(checks).toContain('{asking && <CheckPrintedQuestion check={asking} onDone={() => { setAsking(null); setVersion(v => v + 1); onDone(record); }} />}');
  });
});

describe('Task Sheet freshness (Moshe Henig, 2026-11-11: only after a hard refresh)', () => {
  it('never answers data requests from a cache, and reloads the sheet when tasks change or you come back', () => {
    expect(readFileSync('src/lib/supabase.ts', 'utf8')).toContain("const fresh: RequestInit = { ...init, cache: 'no-store' };");
    const sheet = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
    expect(sheet).toContain("window.addEventListener('task-sheet-changed', again);");
    expect(sheet).toContain("document.addEventListener('visibilitychange', back);");
    expect(readFileSync('src/components/RecordForm.tsx', 'utf8')).toContain("window.dispatchEvent(new Event('task-sheet-changed'));\n      p.onSaved(data);");
  });
});

describe('Email to fundraiser (Moshe Henig, 2026-11-11)', () => {
  it('sits beside Print on the payout, the register, and both Task Sheet check tasks, and both stay available', () => {
    expect(checks).toContain("supabase.rpc('email_check_to_fundraiser', { p_check: checkId, p_pdf_base64: bytesToBase64(bytes) })");
    expect(checks).toContain('<EmailCheckButton checkId={live.id} onSent={() => setVersion(v => v + 1)} />');   // payout, after printing too
    expect(checks).toContain('<EmailCheckButton checkId={checkId} onSent={onDone} />');                          // Check Not Printed task
    expect(checks).toContain("onClick={() => setPrinting('email')}><Mail size={15} /> Email to fundraiser</button>"); // Check To Print task
    expect(checks).toContain("{ label: 'Email to fundraiser', onClick: () => { emailCheck(r.id)");                // register
  });
});
