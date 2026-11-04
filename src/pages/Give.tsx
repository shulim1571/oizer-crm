import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveOrg } from '../lib/org';
import { supabase, type Row } from '../lib/supabase';
import { CardFields } from './Payments';

// A campaign's public payment page, at #/give/<campaign>. No sign-in. Hebrew and Yiddish switch the text
// to right to left; the layout itself doesn't mirror. Card number and CVV go straight to Sola.

type Lang = 'en' | 'he' | 'yi';
const T: Record<Lang, Record<string, string>> = {
  en: {
    recurring: 'Make this a recurring donation', often: 'How often', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Yearly', start: 'Start date', payments: 'Number of payments', until: 'Until I cancel', fixed: 'A set number', series: '{n} payments of {amount}: {total} in total', agree: 'I agree to be charged {amount} each {period}{until}. The office can stop it any time I ask.', agree_until: ' until I ask to stop', agree_n: ' for {n} payments', agree_needed: 'Please confirm the recurring terms.', week: 'week', month: 'month', quarter: 'quarter', year: 'year', text_me: 'Text me about this recurring donation', saved: 'Your card is saved. The first charge of {amount} will be on {date}.', per: 'each',
    raised: 'raised of', goal: 'goal', amount: 'Amount', other: 'Other amount', cover: 'I\'d like to cover the processing fee so 100% of my donation goes to the campaign',
    fee: 'fee', total: 'Total charge', first: 'First name', last: 'Last name', phone: 'Phone', email: 'Email (optional)', country: 'Country',
    address: 'Address (optional)', zip: 'ZIP code', postal: 'Postal code', postcode: 'Postcode', notes: 'Message (optional)', card: 'Card number', cvv: 'CVV',
    exp: 'Expiry (MM/YY)', donate: 'Donate', processing: 'Processing…', loading: 'Loading the secure card fields…', other_ways: 'Other ways to give',
    checks: 'Checks payable to', zelle: 'Zelle', ein: 'EIN', wall: 'Recent donors', anonymous: 'Anonymous', thanks: 'Thank you for your donation to',
    charged: 'Charged', receipt: 'Send me a receipt', receipt_sent: 'Thank you. The office will send your receipt.', another: 'Make another donation',
    confirm: 'You\'re about to donate {amount}. Please confirm this is correct.', min: 'The smallest gift here is {amount}.', choose: 'Choose an amount.',
    unavailable: 'This page isn\'t taking donations right now.', yes: 'Yes', no: 'No', send: 'Send', secure: 'Secured by Sola Payments',
    required: 'required', test: 'Test mode: no real charges. Use card 4111 1111 1111 1111.', robot: 'Please confirm you\'re not a robot.',
  },
  he: {
    recurring: 'תרומה קבועה', often: 'תדירות', weekly: 'שבועי', monthly: 'חודשי', quarterly: 'רבעוני', annually: 'שנתי', start: 'תאריך התחלה', payments: 'מספר תשלומים', until: 'עד שאבטל', fixed: 'מספר קבוע', series: '{n} תשלומים של {amount}: סה״כ {total}', agree: 'אני מסכים לחיוב של {amount} בכל {period}{until}. המשרד יפסיק בכל עת לבקשתי.', agree_until: ' עד שאבקש להפסיק', agree_n: ' למשך {n} תשלומים', agree_needed: 'נא לאשר את תנאי התרומה הקבועה.', week: 'שבוע', month: 'חודש', quarter: 'רבעון', year: 'שנה', text_me: 'שלחו לי הודעות על התרומה הקבועה', saved: 'הכרטיס נשמר. החיוב הראשון של {amount} יהיה ב-{date}.', per: 'בכל',
    raised: 'נאספו מתוך', goal: 'יעד', amount: 'סכום', other: 'סכום אחר', cover: 'אני מעוניין לכסות את עמלת הסליקה כדי שכל תרומתי תגיע למטרה',
    fee: 'עמלה', total: 'סך החיוב', first: 'שם פרטי', last: 'שם משפחה', phone: 'טלפון', email: 'דוא״ל (רשות)', country: 'מדינה',
    address: 'כתובת (רשות)', zip: 'מיקוד', postal: 'מיקוד', postcode: 'מיקוד', notes: 'הודעה (רשות)', card: 'מספר כרטיס', cvv: 'CVV',
    exp: 'תוקף (MM/YY)', donate: 'לתרומה', processing: 'מעבד…', loading: 'טוען את שדות הכרטיס המאובטחים…', other_ways: 'דרכים נוספות לתרום',
    checks: 'צ׳קים לפקודת', zelle: 'Zelle', ein: 'EIN', wall: 'תורמים אחרונים', anonymous: 'בעילום שם', thanks: 'תודה על תרומתך ל',
    charged: 'חויב', receipt: 'שלחו לי קבלה', receipt_sent: 'תודה. המשרד ישלח לך קבלה.', another: 'תרומה נוספת',
    confirm: 'אתה עומד לתרום {amount}. נא לאשר שהסכום נכון.', min: 'התרומה המינימלית היא {amount}.', choose: 'נא לבחור סכום.',
    unavailable: 'דף זה אינו מקבל תרומות כעת.', yes: 'כן', no: 'לא', send: 'שליחה', secure: 'מאובטח על ידי Sola Payments',
    required: 'חובה', test: 'מצב בדיקה: אין חיוב אמיתי. השתמשו בכרטיס 4111 1111 1111 1111.', robot: 'נא לאשר שאינך רובוט.',
  },
  yi: {
    recurring: 'א קבועה נדבה', often: 'ווי אפט', weekly: 'וועכנטליך', monthly: 'כל חודש', quarterly: 'יעדע דריי חדשים', annually: 'יערליך', start: 'אנהייב דאטום', payments: 'צאל באצאלונגען', until: 'ביז איך שטעל אפ', fixed: 'א געוויסע צאל', series: '{n} באצאלונגען פון {amount}: סך הכל {total}', agree: 'איך בין מסכים צו באצאלן {amount} יעדע {period}{until}. דער אפיס קען עס אפשטעלן ווען איך בעט.', agree_until: ' ביז איך בעט אפצושטעלן', agree_n: ' פאר {n} באצאלונגען', agree_needed: 'ביטע באשטעטיגט די תנאים פון דער קבועה נדבה.', week: 'וואך', month: 'חודש', quarter: 'דריי חדשים', year: 'יאר', text_me: 'שיקט מיר מעסעדזשעס וועגן די קבועה נדבה', saved: 'די קארטל איז געהאלטן. די ערשטע באצאלונג פון {amount} וועט זיין {date}.', per: 'יעדע',
    raised: 'געזאמלט פון', goal: 'ציל', amount: 'סכום', other: 'אן אנדער סכום', cover: 'איך וויל צאלן די באארבעטונג אפצאל, כדי מיין גאנצע נדבה זאל אנקומען צום ציל',
    fee: 'אפצאל', total: 'סך הכל', first: 'ערשטער נאמען', last: 'פאמיליע נאמען', phone: 'טעלעפאן', email: 'אימעיל (אויב געוואלט)', country: 'לאנד',
    address: 'אדרעס (אויב געוואלט)', zip: 'זיפ קאוד', postal: 'פאסט קאוד', postcode: 'פאסט קאוד', notes: 'מעסעדזש (אויב געוואלט)', card: 'קארטל נומער', cvv: 'CVV',
    exp: 'ביז (MM/YY)', donate: 'נדבה געבן', processing: 'ארבעט…', loading: 'לאדט די זיכערע קארטל פעלדער…', other_ways: 'אנדערע וועגן צו געבן',
    checks: 'טשעקס צו', zelle: 'Zelle', ein: 'EIN', wall: 'לעצטע נדבנים', anonymous: 'אנאנים', thanks: 'א דאנק פאר אייער נדבה צו',
    charged: 'באצאלט', receipt: 'שיקט מיר א קבלה', receipt_sent: 'א דאנק. דער אפיס וועט אייך שיקן א קבלה.', another: 'נאך א נדבה',
    confirm: 'איר גייט געבן {amount}. ביטע באשטעטיגט אז דאס איז ריכטיג.', min: 'די קלענסטע נדבה דא איז {amount}.', choose: 'ביטע קלייבט א סכום.',
    unavailable: 'דער בלאט נעמט נישט יעצט קיין נדבות.', yes: 'יא', no: 'ניין', send: 'שיקן', secure: 'באשיצט דורך Sola Payments',
    required: 'פארלאנגט', test: 'טעסט: קיין אמת׳ע באצאלונג. ניצט קארטל 4111 1111 1111 1111.', robot: 'ביטע באשטעטיגט אז איר זענט נישט קיין ראבאט.',
  },
};
const COUNTRIES = ['USA', 'Canada', 'Israel', 'England'];
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

type TurnstileApi = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void };
let turnstileLoad: Promise<void> | null = null;
const loadTurnstile = () => (turnstileLoad ??= new Promise<void>((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.onload = () => resolve();
  s.onerror = () => { turnstileLoad = null; reject(new Error('turnstile')); };
  document.head.appendChild(s);
}));

export default function GivePage({ campaignId }: { campaignId: string }) {
  const [orgId, setOrgId] = useState<string | null | undefined>(undefined);
  const [data, setData] = useState<Row | null | undefined>(undefined);
  const [round, setRound] = useState(0);
  const [thanks, setThanks] = useState<Row | null>(null);
  const load = useCallback(async () => {
    const org = await resolveOrg();
    setOrgId(org?.id ?? null);
    if (!org) return setData(null);
    const { data: p } = await supabase.rpc('public_give_page', { p_org: org.id, p_campaign: campaignId });
    setData((p as Row | null) ?? null);
  }, [campaignId]);
  useEffect(() => { void load(); }, [load]);

  const lang: Lang = (data?.page?.language as Lang) ?? 'en';
  // Inside the donate widget, the page tells the host site how tall it is.
  const framed = window.parent !== window;
  useEffect(() => {
    if (!framed) return;
    const send = () => window.parent.postMessage({ type: 'oizer-give-height', height: document.documentElement.scrollHeight }, '*');
    const watch = new ResizeObserver(send);
    watch.observe(document.body);
    send();
    return () => watch.disconnect();
  }, [framed]);
  const t = T[lang];
  const rtl = lang !== 'en';
  useEffect(() => {
    if (data) {
      document.title = data.campaign.name;
      if (data.org.color) document.documentElement.style.setProperty('--give-accent', data.org.color);
    }
  }, [data]);

  if (data === undefined || orgId === undefined) return <div className="splash"><div className="logo">♥</div></div>;
  if (!data || !orgId) return <div className="shared-missing"><h1 dir="auto">{T.en.unavailable}</h1></div>;
  const c = data.campaign;
  const pct = c.goal ? Math.min(100, Math.round((Number(c.raised ?? 0) / Number(c.goal)) * 100)) : 0;
  return (
    <div className={`give ${rtl ? 'give-rtl' : ''} ${framed ? 'give-framed' : ''}`} lang={lang === 'en' ? 'en' : lang === 'he' ? 'he' : 'yi'}>
      <header className="give-head">
        {data.org.logo_url ? <img src={data.org.logo_url} alt={data.org.name} /> : <b>{data.org.name}</b>}
      </header>
      {data.page.banner_url && <img className="give-banner" src={data.page.banner_url} alt="" />}
      <main className="give-main">
        <h1 dir="auto">{c.name}</h1>
        {data.page.description && <p className="give-story" dir="auto">{data.page.description}</p>}
        {c.goal && (
          <div className="give-progress">
            <div className="bar"><span style={{ width: `${pct}%` }} /></div>
            <div dir="auto"><b>{usd(Number(c.raised ?? 0))}</b> {t.raised} {usd(Number(c.goal))} {t.goal} · {pct}%</div>
          </div>
        )}
        {thanks ? (
          <Thanks t={t} data={data} result={thanks} onAgain={() => { setThanks(null); setRound(r => r + 1); void load(); }} />
        ) : !data.payments.ready ? (
          <p className="error" dir="auto">{t.unavailable}</p>
        ) : (
          <GiveForm key={round} t={t} data={data} orgId={orgId} onDone={setThanks} />
        )}
        <section className="give-other">
          <h2 dir="auto">{t.other_ways}</h2>
          {data.org.check_payee && <div dir="auto">{t.checks}: <b>{data.org.check_payee}</b></div>}
          {data.org.zelle && <div dir="auto">{t.zelle}: <b>{data.org.zelle}</b></div>}
          {data.org.ein && <div dir="auto">{t.ein}: <b>{data.org.ein}</b></div>}
        </section>
        {Array.isArray(data.page.donor_wall) && data.page.donor_wall.length > 0 && (
          <section className="give-wall">
            <h2 dir="auto">{t.wall}</h2>
            <ul>{data.page.donor_wall.map((w: Row, i: number) => <li key={i}><span dir="auto">{w.name || t.anonymous}</span><b>{usd(Number(w.amount))}</b></li>)}</ul>
          </section>
        )}
      </main>
      <footer className="give-foot">{t.secure} · {data.org.name}</footer>
    </div>
  );
}

function GiveForm({ t, data, orgId, onDone }: { t: Record<string, string>; data: Row; orgId: string; onDone: (r: Row) => void }) {
  const p = data.page;
  const presets: number[] = (p.presets ?? []).map(Number);
  const [amount, setAmount] = useState<number | null>(p.suggested ? Number(p.suggested) : null);
  const [other, setOther] = useState('');
  const [cover, setCover] = useState<boolean>(!!p.cover_fee_default);
  const [coverTotal, setCoverTotal] = useState<number | null>(null);
  const [d, setD] = useState({ first_name: '', last_name: '', phone: '', email: '', country: 'USA', address: '', zip: '', notes: '' });
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [exp, setExp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [human, setHuman] = useState<string | null>(null);
  const tokens = useRef<() => Promise<{ card: string; cvv: string }>>();
  const setTokens = useRef((get: () => Promise<{ card: string; cvv: string }>) => { tokens.current = get; }).current;
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstileId = useRef<string | null>(null);

  const todayIso = new Date().toLocaleDateString('en-CA');
  const [rec, setRec] = useState({ on: false, frequency: 'monthly' as 'weekly' | 'monthly' | 'quarterly' | 'annually', start: todayIso, fixed: false, count: '12', textMe: false, agreed: false });
  const chosen = other ? Number(other) : amount;
  useEffect(() => {
    if (!p.cover_fee || !cover || !(chosen && chosen > 0)) return setCoverTotal(null);
    const timer = window.setTimeout(() => {
      supabase.rpc('public_cover_fee', { p_org: orgId, p_campaign: data.campaign.id, p_amount: chosen })
        .then(({ data: total }) => setCoverTotal(total != null ? Number(total) : null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chosen, cover, p.cover_fee, orgId, data.campaign.id]);
  useEffect(() => {
    if (!TURNSTILE_KEY || !turnstileBox.current) return;
    loadTurnstile().then(() => {
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (ts && turnstileBox.current && !turnstileId.current) {
        turnstileId.current = ts.render(turnstileBox.current, { sitekey: TURNSTILE_KEY, callback: (tok: string) => setHuman(tok), 'expired-callback': () => setHuman(null) });
      }
    }).catch(() => setError('Couldn\'t load the robot check. Please refresh the page.'));
  }, []);

  const total = cover && coverTotal ? coverTotal : chosen ?? 0;
  const period = { weekly: t.week, monthly: t.month, quarterly: t.quarter, annually: t.year }[rec.frequency];
  const count = rec.fixed ? Number(rec.count) : null;
  const terms = t.agree.replace('{amount}', usd(total)).replace('{period}', period)
    .replace('{until}', count ? t.agree_n.replace('{n}', String(count)) : t.agree_until);
  const fields: Row[] = p.custom_fields ?? [];
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD(x => ({ ...x, [k]: e.target.value }));
  const zipLabel = d.country === 'USA' ? t.zip : d.country === 'England' ? t.postcode : t.postal;
  const expDigits = exp.replace(/\D/g, '');

  async function submit(confirmed = false) {
    setError(null);
    if (!(chosen && chosen > 0)) return setError(t.choose);
    if (p.min && chosen < Number(p.min)) return setError(t.min.replace('{amount}', usd(Number(p.min))));
    if (rec.on && !rec.agreed) return setError(t.agree_needed);
    if (rec.on && rec.fixed && !(count && count >= 2)) return setError(t.payments);
    if (!confirmed && chosen > Number(p.confirm_over ?? 5000)) return setConfirming(true);
    setConfirming(false);
    if (TURNSTILE_KEY && !human) return setError(t.robot);
    setBusy(true);
    try {
      const card = await tokens.current!();
      const { data: r, error: e } = await supabase.functions.invoke('give', {
        body: {
          org: orgId, campaign: data.campaign.id, amount: chosen, cover_fee: cover && !!p.cover_fee, donor: d, custom, card_sut: card.card, cvv_sut: card.cvv, exp: expDigits, turnstile: human,
          recurring: rec.on ? { frequency: rec.frequency, start: rec.start, count, text_me: rec.textMe } : null,
        },
      });
      if (e) throw new Error('Something went wrong. Please try again.');
      if (r.approved) return onDone(r);
      setError(r.error ?? 'The card was declined.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // A robot check is good for one try.
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (TURNSTILE_KEY && ts && turnstileId.current) { ts.reset(turnstileId.current); setHuman(null); }
    }
  }

  return (
    <form className="give-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {data.payments.sandbox && <p className="give-test" dir="auto">{t.test}</p>}
      <div className="give-logos" aria-hidden="true"><span>VISA</span><span>Mastercard</span><span>AMEX</span><span>Discover</span></div>
      <label className="give-label" dir="auto">{t.amount}</label>
      {presets.length > 0 && (
        <div className="give-presets">
          {presets.map(a => (
            <button type="button" key={a} className={`${amount === a && !other ? 'on' : ''} ${Number(p.suggested) === a ? 'suggested' : ''}`}
              onClick={() => { setAmount(a); setOther(''); }}>{usd(a)}</button>
          ))}
        </div>
      )}
      {p.allow_other && (
        <input className="give-other-amount" type="number" inputMode="decimal" min={p.min ?? 1} step="0.01" placeholder={t.other} value={other}
          onChange={e => setOther(e.target.value)} dir="auto" />
      )}
      {p.cover_fee && (
        <label className="inline-check give-cover"><input type="checkbox" checked={cover} onChange={e => setCover(e.target.checked)} />
          <span dir="auto">{t.cover}{cover && coverTotal && chosen ? ` (+ ${usd(coverTotal - chosen)} ${t.fee})` : ''}</span></label>
      )}

      <label className="inline-check give-cover"><input type="checkbox" checked={rec.on} onChange={e => setRec(r => ({ ...r, on: e.target.checked }))} />
        <span dir="auto"><b>{t.recurring}</b></span></label>
      {rec.on && (
        <div className="give-recurring">
          <div className="give-grid">
            <label className="field"><span dir="auto">{t.often}</span>
              <select value={rec.frequency} onChange={e => setRec(r => ({ ...r, frequency: e.target.value as typeof r.frequency }))}>
                {(['weekly', 'monthly', 'quarterly', 'annually'] as const).map(f => <option key={f} value={f}>{t[f]}</option>)}
              </select></label>
            <label className="field"><span dir="auto">{t.start}</span><input type="date" dir="ltr" min={todayIso} value={rec.start} onChange={e => setRec(r => ({ ...r, start: e.target.value }))} /></label>
            <label className="field"><span dir="auto">{t.payments}</span>
              <select value={rec.fixed ? 'n' : 'until'} onChange={e => setRec(r => ({ ...r, fixed: e.target.value === 'n' }))}>
                <option value="until">{t.until}</option><option value="n">{t.fixed}</option>
              </select></label>
            {rec.fixed && <label className="field"><span dir="auto">#</span><input type="number" min={2} max={520} dir="ltr" value={rec.count} onChange={e => setRec(r => ({ ...r, count: e.target.value }))} /></label>}
          </div>
          {count && count >= 2 && chosen ? <p dir="auto"><b>{t.series.replace('{n}', String(count)).replace('{amount}', usd(total)).replace('{total}', usd(total * count))}</b></p> : null}
          <label className="inline-check"><input type="checkbox" checked={rec.textMe} onChange={e => setRec(r => ({ ...r, textMe: e.target.checked }))} /> <span dir="auto">{t.text_me}</span></label>
          <label className="inline-check"><input type="checkbox" checked={rec.agreed} onChange={e => setRec(r => ({ ...r, agreed: e.target.checked }))} /> <span dir="auto">{terms}</span></label>
        </div>
      )}

      <div className="give-grid">
        <label className="field"><span dir="auto">{t.first} *</span><input required dir="auto" value={d.first_name} onChange={set('first_name')} autoComplete="given-name" /></label>
        <label className="field"><span dir="auto">{t.last} *</span><input required dir="auto" value={d.last_name} onChange={set('last_name')} autoComplete="family-name" /></label>
        <label className="field"><span dir="auto">{t.phone} *</span><input required type="tel" dir="ltr" value={d.phone} onChange={set('phone')} autoComplete="tel" /></label>
        <label className="field"><span dir="auto">{t.email}</span><input type="email" dir="ltr" value={d.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="field"><span dir="auto">{t.country}</span>
          <select value={d.country} onChange={set('country')}>{COUNTRIES.map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="field"><span dir="auto">{zipLabel}</span><input dir="ltr" value={d.zip} onChange={set('zip')} autoComplete="postal-code" /></label>
        <label className="field wide"><span dir="auto">{t.address}</span><input dir="auto" value={d.address} onChange={set('address')} autoComplete="street-address" /></label>
        {fields.filter(f => f.name).map(f => (
          f.type === 'checkbox'
            ? <label key={f.name} className="inline-check wide"><input type="checkbox" checked={custom[f.name] === 'true'} onChange={e => setCustom(x => ({ ...x, [f.name]: String(e.target.checked) }))} />
                <span dir="auto">{f.name}{f.required ? ' *' : ''}</span></label>
            : <label key={f.name} className="field"><span dir="auto">{f.name}{f.required ? ' *' : ''}</span>
                <input dir="auto" required={!!f.required} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  value={custom[f.name] ?? ''} onChange={e => setCustom(x => ({ ...x, [f.name]: e.target.value }))} /></label>
        ))}
        <label className="field wide"><span dir="auto">{t.notes}</span><textarea dir="auto" rows={2} value={d.notes} onChange={set('notes')} /></label>
      </div>

      <CardFields ifieldsKey={data.payments.ifields_key} onTokens={setTokens} labels={{ card: t.card, cvv: t.cvv, loading: t.loading }} />
      <label className="field give-exp"><span dir="auto">{t.exp}</span><input inputMode="numeric" maxLength={5} placeholder="MM/YY" dir="ltr" value={exp} required
        onChange={e => { const x = e.target.value.replace(/\D/g, '').slice(0, 4); setExp(x.length > 2 ? `${x.slice(0, 2)}/${x.slice(2)}` : x); }} /></label>

      {TURNSTILE_KEY && <div ref={turnstileBox} className="give-turnstile" />}
      {chosen ? <div className="give-total" dir="auto">{t.total}: <b>{usd(total)}</b></div> : null}
      {confirming && (
        <div className="give-confirm" dir="auto">{t.confirm.replace('{amount}', usd(chosen ?? 0))}
          <div><button type="button" className="btn primary" onClick={() => submit(true)}>{t.yes}</button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>{t.no}</button></div></div>
      )}
      {error && <div className="error" dir="auto">{error}</div>}
      <button type="submit" className="btn primary give-submit" disabled={busy || expDigits.length !== 4}>{busy ? t.processing : `${t.donate}${chosen ? ` ${usd(total)}` : ''}`}</button>
    </form>
  );
}

function Thanks({ t, data, result, onAgain }: { t: Record<string, string>; data: Row; result: Row; onAgain: () => void }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = useMemo(() => usd(Number(result.amount)), [result.amount]);
  async function ask() {
    setError(null);
    const { error: e } = await supabase.rpc('request_receipt', { p_token: result.token, p_email: email || null, p_phone: phone || null });
    if (e) return setError(e.message);
    setSent(true);
  }
  return (
    <section className="give-thanks">
      <h2 dir="auto">{t.thanks} {data.campaign.name}!</h2>
      {data.page.thank_you && <p dir="auto">{data.page.thank_you}</p>}
      {result.scheduled
        ? <p dir="auto">{t.saved.replace('{amount}', usd(Number(result.per))).replace('{date}', result.start ? new Date(`${result.start}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '')}</p>
        : <p dir="auto">{t.charged}: <b>{amount}</b>{result.card ? ` · ${result.card}` : ''}</p>}
      {!result.token ? null : sent ? <p dir="auto">{t.receipt_sent}</p> : asking ? (
        <div className="give-grid">
          <label className="field"><span dir="auto">{t.email}</span><input type="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="field"><span dir="auto">{t.phone}</span><input type="tel" dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} /></label>
          <button type="button" className="btn primary" disabled={!email.trim() && !phone.trim()} onClick={ask}>{t.send}</button>
        </div>
      ) : <button type="button" className="btn" onClick={() => setAsking(true)}>{t.receipt}</button>}
      {error && <div className="error" dir="auto">{error}</div>}
      <button type="button" className="btn primary give-submit" onClick={onAgain}>{t.another}</button>
    </section>
  );
}
