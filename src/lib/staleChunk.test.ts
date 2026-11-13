import { describe, expect, it } from 'vitest';
import { STALE_MESSAGE, friendlyError, isStaleChunkError } from './staleChunk';

describe('out-of-date page detection', () => {
  it('recognizes a code file that no longer exists after a deploy, in each browser', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://oizer.trubase.org/assets/checkPdf-ENIuWrWs.js'))).toBe(true); // Chrome
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true); // Safari
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module: https://x/assets/a.js'))).toBe(true); // Firefox
    expect(isStaleChunkError('Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"')).toBe(true);
  });
  it('leaves other errors alone', () => {
    expect(isStaleChunkError(new Error('Choose a bank account'))).toBe(false);
    expect(friendlyError(new Error('Choose a bank account'))).toBe('Choose a bank account');
    expect(friendlyError(new TypeError('Importing a module script failed.'))).toBe(STALE_MESSAGE);
  });
});
