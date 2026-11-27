import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { phoneCodeProblem } from './phoneCodeResult';

// Shulim, 2026-11-11: his right code was accepted by the database but shown as wrong in the app.
describe('reading the answer to a text or call code', () => {
  it('treats a right code as success, with no message', () => {
    expect(phoneCodeProblem('ok')).toBeNull();
  });
  it('explains every other answer', () => {
    expect(phoneCodeProblem('wrong')).toMatch(/isn’t right/);
    expect(phoneCodeProblem('expired')).toMatch(/expired/);
    expect(phoneCodeProblem('used')).toMatch(/already used/);
    expect(phoneCodeProblem('locked')).toMatch(/Too many wrong tries/);
    expect(phoneCodeProblem('not_found')).toMatch(/isn’t valid/);
    expect(phoneCodeProblem(null)).toMatch(/didn’t work/);
  });
  it('is what the app uses after asking the database', () => {
    expect(readFileSync('src/lib/mfa.ts', 'utf8')).toMatch(/rpc\('mfa_phone_verify'[^]*return phoneCodeProblem\(data\);/);
  });
});
