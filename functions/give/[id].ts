// Link previews for payment links. /give/<campaign> is the same page as #/give/<campaign>, but because it's a real
// path, the services that draw link previews (WhatsApp, iMessage, Facebook, Slack...) can ask for it. This puts the
// campaign's name, story and image into the page's preview tags; the app then loads as usual and shows the page.
// Uses only the public payment page data, with the public (anon) key the web app already ships.
import { DEFAULT_ORG, SUPABASE_ANON_KEY, SUPABASE_URL } from '../_config';
import { plainText } from '../../src/lib/richText';

interface Ctx { request: Request; params: { id: string | string[] }; env: { ASSETS: { fetch: (r: Request | URL) => Promise<Response> } } }
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// Only web addresses: an uploaded logo (a data: image) can't be fetched by link-preview services.
const absolute = (u: unknown, base: string) => { try { const h = u ? new URL(String(u), base).href : null; return h && /^https?:/i.test(h) ? h : null; } catch { return null; } };

async function rpc(name: string, body: Json) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  return res.ok ? res.json() : null;
}

/** The preview tags for one campaign, from its public payment page data. Exported for tests. */
export function previewTags(page: Json, orgFallback: string, url: URL) {
  const name = String(page.campaign.name);
  const orgName = String(page.org?.name ?? orgFallback ?? '');
  // Formatted descriptions are HTML: the preview uses their plain text.
  const story = plainText(String(page.page?.description ?? '')).replace(/\s+/g, ' ').trim();
  const raised = Number(page.campaign.raised ?? 0), goal = Number(page.campaign.goal ?? 0);
  const progress = goal > 0 ? ` ${Math.min(100, Math.round((raised / goal) * 100))}% of the $${goal.toLocaleString('en-US')} goal raised.` : '';
  const description = story ? (story.length > 180 ? `${story.slice(0, 177)}…` : story) : `Support ${name}${orgName ? ` with ${orgName}` : ''}. Give securely online.${progress}`;
  const banner = absolute(page.page?.banner_url, url.href);
  const image = banner ?? absolute(page.org?.logo_url, url.href);
  return {
    title: orgName ? `${name} · ${orgName}` : name,
    tags: [
      `<meta name="description" content="${esc(description)}" />`,
      `<meta property="og:type" content="website" />`,
      orgName ? `<meta property="og:site_name" content="${esc(orgName)}" />` : '',
      `<meta property="og:title" content="${esc(`Donate to ${name}`)}" />`,
      `<meta property="og:description" content="${esc(description)}" />`,
      `<meta property="og:url" content="${esc(url.origin + url.pathname)}" />`,
      image ? `<meta property="og:image" content="${esc(image)}" />` : '',
      // A wide card only for a banner; a logo shows as the small square card.
      `<meta name="twitter:card" content="${banner ? 'summary_large_image' : 'summary'}" />`,
      `<meta name="twitter:title" content="${esc(`Donate to ${name}`)}" />`,
      `<meta name="twitter:description" content="${esc(description)}" />`,
      image ? `<meta name="twitter:image" content="${esc(image)}" />` : '',
    ].filter(Boolean),
  };
}

/** index.html with the campaign's title and preview tags in place of the defaults. Exported for tests. */
export function withPreview(html: string, p: { title: string; tags: string[] }) {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`)
    .replace(/\s*<meta (name="description"|property="og:[a-z_]+"|name="twitter:[a-z]+") [^>]*>/g, '')
    .replace('</head>', `    ${p.tags.join('\n    ')}\n  </head>`);
}

export async function onRequestGet({ request, params, env }: Ctx) {
  const url = new URL(request.url);
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id);
  let html = await (await env.ASSETS.fetch(new URL('/', url))).text();
  if (/^[A-Za-z0-9-]{1,40}$/.test(id)) {
    try {
      // The address decides the organization; the default one only where the address belongs to none (pages.dev).
      let [org] = (await rpc('resolve_org', { p_host: url.hostname, p_slug: null })) ?? [];
      if (!org && DEFAULT_ORG) [org] = (await rpc('resolve_org', { p_host: url.hostname, p_slug: DEFAULT_ORG })) ?? [];
      const page = org ? await rpc('public_give_page', { p_org: org.id, p_campaign: id }) : null;
      if (page?.campaign) html = withPreview(html, previewTags(page, org.name, url));
    } catch {
      // No preview details: the page still works.
    }
  }
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Never a stale copy: the campaign's name and details are always current (Moshe Henig, 2026-11-11).
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    },
  });
}
