import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: recognized devices and addresses skip the sign-in code.
describe('trusted sign-in', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  it('checks for a trusted device or address before asking for the code', () => {
    expect(app).toContain('void checkTrustedSignIn().then(how => { setTrust(\'checked\'); if (how) void mfa.reload(); });');
    expect(app).toContain("if (needsCode && trust !== 'checked') return <div className=\"splash\">");
  });
  it('offers to trust the device after a correct code, ticked by default', () => {
    expect(app).toContain('const [trustMe, setTrustMe] = useState(true);');
    expect(app).toContain('void (trustMe ? trustThisDevice() : Promise.resolve()).finally(() => void mfa.reload());');
    expect(readFileSync('src/lib/trustedDevice.ts', 'utf8')).toContain('export const TRUST_DAYS = 30;');
    expect(readFileSync('src/pages/Security.tsx', 'utf8')).toContain("supabase.rpc('mfa_forget_devices')");
  });
});
