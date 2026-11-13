/**
 * Base64 to bytes, without trusting the text to be tidy. The check files (signature, MICR font) come back from
 * the database as base64 wrapped every 76 characters, and on the way something can still change them: a
 * content filter or proxy, a data: URL prefix, URL-safe letters (- and _), missing padding. atob() refuses all
 * of that with "The string to be decoded is not correctly encoded" (Moshe Henig, 2026-11-10, Print again on
 * check #5007), so this tidies first and, when the text really isn't base64, says what it got instead.
 */
export class Base64Error extends Error {}

export function fromBase64(input: unknown, what = 'file'): Uint8Array {
  if (typeof input !== 'string') throw new Base64Error(`The ${what} didn't come back as text (got ${input === null ? 'nothing' : typeof input}). Reload the page and try again.`);
  let s = input.trim().replace(/^data:[^,]*,/i, '');
  if (/^<|^\{/.test(s)) throw new Base64Error(`The ${what} came back as a web page instead of the file (starts "${s.slice(0, 20).replace(/\s+/g, ' ')}…"). A filter or proxy on this connection may be changing it; try another connection or browser.`);
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const bad = s.replace(/=+$/, '').match(/[^A-Za-z0-9+/]/);
  if (bad) throw new Base64Error(`The ${what} came back damaged (an unexpected "${bad[0]}" at character ${s.indexOf(bad[0]) + 1} of ${s.length}). A filter or proxy on this connection may be changing it; reload, or try another connection.`);
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Base64Error(`The ${what} came back cut short (${s.length} characters). Reload the page and try again.`);
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hex to bytes, for check and receipt files (2026-11-11: base64 PNG text was rewritten on the way by a content
 * filter; hex doesn't look like an image). Whitespace is ignored; anything else that isn't hex is reported.
 */
export function fromHex(input: unknown, what = 'file'): Uint8Array {
  if (typeof input !== 'string') throw new Base64Error(`The ${what} didn't come back as text (got ${input === null ? 'nothing' : typeof input}). Reload the page and try again.`);
  const s = input.replace(/^\\x/i, '').replace(/\s+/g, '');
  const bad = s.match(/[^0-9a-fA-F]/);
  if (bad) throw new Base64Error(`The ${what} came back damaged (an unexpected "${bad[0]}" at character ${s.indexOf(bad[0]) + 1} of ${s.length}). A filter or proxy on this connection may be changing it; reload, or try another connection.`);
  if (s.length % 2) throw new Base64Error(`The ${what} came back cut short (${s.length} characters). Reload the page and try again.`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes to base64, for a local data: URL or for saving a file again. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
