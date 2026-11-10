// Outreach message formatting shared by the composer and the New Template form.

/** Texts can't show bold or italic, so their markers come out rather than arriving as stars. */
export const smsPlain = (s: string) => s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
/** What the New Template form and the composer say about formatting. */
export const EMAIL_HELP = '**bold** and *italic* are supported, and web addresses become links.';
export const SMS_HELP = 'Texts are plain: **bold** and *italic* markers are taken out. Web addresses go as typed; most phones make them tappable.';
export const MERGE_FIELDS = ['{first_name}', '{last_name}', '{campaign_name}'];
