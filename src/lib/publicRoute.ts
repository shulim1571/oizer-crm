// A campaign's public payment page: #/give/<campaign>, or /give/<campaign>, the address shared links use so that link
// previews (served by functions/give/[id].ts) can show the campaign. Read once at startup.
export const giveCampaignId: string | null =
  /^#\/give\/([A-Za-z0-9-]{1,40})\/?$/.exec(window.location.hash)?.[1]
  ?? (!window.location.hash || window.location.hash === '#' ? /^\/give\/([A-Za-z0-9-]{1,40})\/?$/.exec(window.location.pathname)?.[1] : undefined)
  ?? null;
