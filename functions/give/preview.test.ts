import { describe, expect, it, vi } from 'vitest';

vi.mock('../_config', () => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon', DEFAULT_ORG: 'oizer' }));
const { previewTags, withPreview } = await import('./[id]');

const INDEX = `<html><head>
    <title>Campaign CRM</title>
    <meta name="description" content="Give securely online." />
    <meta property="og:title" content="Donate" />
    <meta name="twitter:card" content="summary_large_image" />
  </head><body></body></html>`;
const url = new URL('https://oizer.trubase.org/give/1002');

describe('payment link previews', () => {
  it('show the campaign, its story and banner', () => {
    const p = previewTags({ campaign: { name: 'Oizer second', raised: 500, goal: 1000 }, org: { name: 'Oizer' },
      page: { description: 'Help a family in need.', banner_url: '/banners/1002.jpg' } }, 'Oizer', url);
    const html = withPreview(INDEX, p);
    expect(html).toContain('<title>Oizer second · Oizer</title>');
    expect(html).toContain('<meta property="og:title" content="Donate to Oizer second" />');
    expect(html).toContain('<meta property="og:description" content="Help a family in need." />');
    expect(html).toContain('<meta property="og:image" content="https://oizer.trubase.org/banners/1002.jpg" />');
    expect(html).toContain('<meta property="og:url" content="https://oizer.trubase.org/give/1002" />');
    // The defaults are replaced, not repeated.
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).not.toContain('content="Donate"');
  });

  it('fall back to progress and the logo, and keep text out of the HTML', () => {
    const p = previewTags({ campaign: { name: 'A <b>"bold"</b> plan', raised: 250, goal: 1000 }, org: { name: 'Oizer', logo_url: 'https://cdn.example.org/logo.png' }, page: {} }, 'Oizer', url);
    const html = withPreview(INDEX, p);
    expect(html).toContain('25% of the $1,000 goal raised.');
    expect(html).toContain('content="https://cdn.example.org/logo.png"');
    expect(html).not.toContain('<b>');
    expect(html).toContain('A &lt;b&gt;&quot;bold&quot;&lt;/b&gt; plan');
  });

  it('shorten a long story', () => {
    const p = previewTags({ campaign: { name: 'X' }, page: { description: 'word '.repeat(100) } }, '', url);
    const d = p.tags.find(t => t.includes('og:description'))!;
    expect(d.length).toBeLessThan(260);
    expect(d).toContain('…');
  });
});
