// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isRichText, plainText, sanitizeHtml, textToHtml } from './richText';

// Moshe Henig, 2026-11-11: the campaign description takes fonts, bold, lists and so on; what's stored is cleaned.
describe('formatted descriptions', () => {
  it('keep bold, italic, underline, lists, headings, alignment, fonts and sizes', () => {
    const html = '<p style="text-align: center"><b>Help</b> <i>us</i> <u>now</u></p><ul><li>one</li></ul><font face="Georgia" size="5">big</font>';
    expect(sanitizeHtml(html)).toBe('<p style="text-align: center"><b>Help</b> <i>us</i> <u>now</u></p><ul><li>one</li></ul><span style="font-family: \'Georgia\'; font-size: 22px">big</span>');
  });

  it('drop scripts, event handlers, unsafe links and unknown styles, keeping plain text', () => {
    const html = '<p onclick="steal()">Hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a><a href="https://oizer.org">site</a>'
      + '<img src=x onerror=alert(1)><span style="position: fixed; color: red; font-size: 99px">t</span><iframe src="https://evil"></iframe>';
    const out = sanitizeHtml(html);
    expect(out).toBe('<p>Hi</p><a>x</a><a href="https://oizer.org" target="_blank" rel="noopener noreferrer nofollow">site</a><span>t</span>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript|iframe|img|position/);
  });

  it('tell formatted text from older plain text, and give the plain text for previews', () => {
    expect(isRichText('Just a story\nwith lines')).toBe(false);
    expect(isRichText('<p>Formatted</p>')).toBe(true);
    expect(plainText('<p><b>Help</b> us &amp; them</p><ul><li>one</li></ul>')).toBe('Help us & them\none');
    expect(textToHtml('a < b\nnext\n\npara')).toBe('<p>a &lt; b<br>next</p><p>para</p>');
  });
});
