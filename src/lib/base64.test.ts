import { describe, expect, it } from 'vitest';
import { fromBase64 } from './base64';

// Moshe Henig, 2026-11-10: Print again on check #5007 failed with "Failed to execute 'atob' on 'Window': The
// string to be decoded is not correctly encoded."
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xfb, 0xff, 0xfe]);
const b64 = Buffer.from(PNG).toString('base64');
// What Postgres's encode(..., 'base64') returns for a real file: lines of 76 characters.
const wrap = (s: string) => s.replace(/(.{76})/g, '$1\n');
const big = Buffer.from(Array.from({ length: 9000 }, (_, i) => (i * 37) % 256));

describe('fromBase64 for check files', () => {
  it('decodes what the database returns, wrapped every 76 characters', () => {
    expect(Buffer.from(fromBase64(wrap(big.toString('base64'))))).toEqual(big);
    expect(fromBase64(b64)).toEqual(PNG);
  });

  it('copes with what a proxy, filter or browser may do to it', () => {
    expect(fromBase64(`data:image/png;base64,${b64}`)).toEqual(PNG);                       // a data: URL
    expect(fromBase64(b64.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(PNG);           // URL-safe letters
    expect(fromBase64(b64.replace(/=+$/, ''))).toEqual(PNG);                                // no padding
    expect(fromBase64(`  ${wrap(big.toString('base64')).replace(/\n/g, '\r\n')}  `)).toEqual(new Uint8Array(big)); // CRLF, spaces
  });

  it('says what went wrong instead of the browser\'s atob message', () => {
    expect(() => fromBase64('<html><body>Blocked</body></html>', 'signature file')).toThrow(/signature file came back as a web page/);
    expect(() => fromBase64('iVBORw0K%%GgoA', 'MICR font file')).toThrow(/MICR font file came back damaged \(an unexpected "%"/);
    expect(() => fromBase64('iVBORw0KG', 'signature file')).toThrow(/cut short/);
    expect(() => fromBase64(null, 'signature file')).toThrow(/didn't come back as text/);
    expect(() => fromBase64('iVBORw0K%%GgoA')).not.toThrow(/atob/);
  });
});
