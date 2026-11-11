import OrgContact from '../components/OrgContact';
import { PoweredBy } from '../components/PoweredBy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveOrg } from '../lib/org';
import { supabase, type Row } from '../lib/supabase';
import { CardFields } from './Payments';
import {
  BankFields, DafFields, MethodTabs, PAY_EN, bankBody, bankProblem, dafBody, dafProblem, emptyBank, emptyDaf,
  type BankValue, type DafValue, type Method, type PayLabels,
} from './PayMethods';

// A campaign's public payment page, at #/give/<campaign>. No sign-in. Hebrew and Yiddish switch the text
// to right to left; the layout itself doesn't mirror. Card number and CVV go straight to Sola.

type Lang = 'en' | 'he' | 'yi';
const T: Record<Lang, Record<string, string>> = {
  en: {
    recurring: 'Make this a recurring donation', often: 'How often', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Yearly', start: 'Start date', payments: 'Number of payments', until: 'Until I cancel', fixed: 'A set number', series: '{n} payments of {amount}: {total} in total', agree: 'I agree to be charged {amount} each {period}{until}. The office can stop it any time I ask.', agree_until: ' until I ask to stop', agree_n: ' for {n} payments', agree_needed: 'Please confirm the recurring terms.', week: 'week', month: 'month', quarter: 'quarter', year: 'year', text_me: 'Text me about this recurring donation', saved: 'Your card is saved. The first charge of {amount} will be on {date}.', per: 'each',
    raised: 'raised of', goal: 'goal', amount: 'Amount', other: 'Other amount', cover: 'I\'d like to cover the processing fee so 100% of my donation goes to the campaign',
    fee: 'fee', total: 'Total charge', first: 'First name', last: 'Last name', phone: 'Phone', email: 'Email (optional)', country: 'Country',
    address: 'Address (optional)', zip: 'ZIP code', postal: 'Postal code', postcode: 'Postcode', notes: 'Message (optional)', card: 'Card number', cvv: 'CVV',
    exp: 'Exp.', donate: 'Donate', processing: 'Processing…', loading: 'Loading the secure card fields…', other_ways: 'Other ways to give', teams: 'Teams', include_id: 'Make sure to include the campaign ID',
    checks: 'Checks payable to', zelle: 'Zelle', ein: 'EIN', wall: 'Recent donors', anonymous: 'Anonymous', thanks: 'Thank you for your donation to',
    charged: 'Charged', receipt: 'Send me a receipt', receipt_sent: 'Thank you. The office will send your receipt.', another: 'Make another donation',
    confirm: 'You\'re about to donate {amount}. Please confirm this is correct.', min: 'The smallest gift here is {amount}.', choose: 'Choose an amount.',
    unavailable: 'This page isn\'t taking donations right now.', yes: 'Yes', no: 'No', send: 'Send', secure: 'Secured by Sola Payments',
    required: 'required', test: 'Test mode: no real charges. Use card 4111 1111 1111 1111.', robot: 'Please confirm you\'re not a robot.',
    details: 'Your details', read_more: 'Read more', safe: 'Your card details go straight to the payment processor. We never see or store them.', of_goal: 'of {goal} goal',
  },
  he: {
    recurring: 'תרומה קבועה', often: 'תדירות', weekly: 'שבועי', monthly: 'חודשי', quarterly: 'רבעוני', annually: 'שנתי', start: 'תאריך התחלה', payments: 'מספר תשלומים', until: 'עד שאבטל', fixed: 'מספר קבוע', series: '{n} תשלומים של {amount}: סה״כ {total}', agree: 'אני מסכים לחיוב של {amount} בכל {period}{until}. המשרד יפסיק בכל עת לבקשתי.', agree_until: ' עד שאבקש להפסיק', agree_n: ' למשך {n} תשלומים', agree_needed: 'נא לאשר את תנאי התרומה הקבועה.', week: 'שבוע', month: 'חודש', quarter: 'רבעון', year: 'שנה', text_me: 'שלחו לי הודעות על התרומה הקבועה', saved: 'הכרטיס נשמר. החיוב הראשון של {amount} יהיה ב-{date}.', per: 'בכל',
    raised: 'נאספו מתוך', goal: 'יעד', amount: 'סכום', other: 'סכום אחר', cover: 'אני מעוניין לכסות את עמלת הסליקה כדי שכל תרומתי תגיע למטרה',
    fee: 'עמלה', total: 'סך החיוב', first: 'שם פרטי', last: 'שם משפחה', phone: 'טלפון', email: 'דוא״ל (רשות)', country: 'מדינה',
    address: 'כתובת (רשות)', zip: 'מיקוד', postal: 'מיקוד', postcode: 'מיקוד', notes: 'הודעה (רשות)', card: 'מספר כרטיס', cvv: 'CVV',
    exp: 'תוקף', donate: 'לתרומה', processing: 'מעבד…', loading: 'טוען את שדות הכרטיס המאובטחים…', other_ways: 'דרכים נוספות לתרום', teams: 'צוותים', include_id: 'הקפידו לציין את מספר הקמפיין',
    checks: 'צ׳קים לפקודת', zelle: 'Zelle', ein: 'EIN', wall: 'תורמים אחרונים', anonymous: 'בעילום שם', thanks: 'תודה על תרומתך ל',
    charged: 'חויב', receipt: 'שלחו לי קבלה', receipt_sent: 'תודה. המשרד ישלח לך קבלה.', another: 'תרומה נוספת',
    confirm: 'אתה עומד לתרום {amount}. נא לאשר שהסכום נכון.', min: 'התרומה המינימלית היא {amount}.', choose: 'נא לבחור סכום.',
    unavailable: 'דף זה אינו מקבל תרומות כעת.', yes: 'כן', no: 'לא', send: 'שליחה', secure: 'מאובטח על ידי Sola Payments',
    required: 'חובה', test: 'מצב בדיקה: אין חיוב אמיתי. השתמשו בכרטיס 4111 1111 1111 1111.', robot: 'נא לאשר שאינך רובוט.',
    details: 'הפרטים שלך', read_more: 'קרא עוד', safe: 'פרטי הכרטיס עוברים ישירות לחברת הסליקה. איננו רואים או שומרים אותם.', of_goal: 'מתוך יעד של {goal}',
  },
  yi: {
    recurring: 'א קבועה נדבה', often: 'ווי אפט', weekly: 'וועכנטליך', monthly: 'כל חודש', quarterly: 'יעדע דריי חדשים', annually: 'יערליך', start: 'אנהייב דאטום', payments: 'צאל באצאלונגען', until: 'ביז איך שטעל אפ', fixed: 'א געוויסע צאל', series: '{n} באצאלונגען פון {amount}: סך הכל {total}', agree: 'איך בין מסכים צו באצאלן {amount} יעדע {period}{until}. דער אפיס קען עס אפשטעלן ווען איך בעט.', agree_until: ' ביז איך בעט אפצושטעלן', agree_n: ' פאר {n} באצאלונגען', agree_needed: 'ביטע באשטעטיגט די תנאים פון דער קבועה נדבה.', week: 'וואך', month: 'חודש', quarter: 'דריי חדשים', year: 'יאר', text_me: 'שיקט מיר מעסעדזשעס וועגן די קבועה נדבה', saved: 'די קארטל איז געהאלטן. די ערשטע באצאלונג פון {amount} וועט זיין {date}.', per: 'יעדע',
    raised: 'געזאמלט פון', goal: 'ציל', amount: 'סכום', other: 'אן אנדער סכום', cover: 'איך וויל צאלן די באארבעטונג אפצאל, כדי מיין גאנצע נדבה זאל אנקומען צום ציל',
    fee: 'אפצאל', total: 'סך הכל', first: 'ערשטער נאמען', last: 'פאמיליע נאמען', phone: 'טעלעפאן', email: 'אימעיל (אויב געוואלט)', country: 'לאנד',
    address: 'אדרעס (אויב געוואלט)', zip: 'זיפ קאוד', postal: 'פאסט קאוד', postcode: 'פאסט קאוד', notes: 'מעסעדזש (אויב געוואלט)', card: 'קארטל נומער', cvv: 'CVV',
    exp: 'ביז', donate: 'נדבה געבן', processing: 'ארבעט…', loading: 'לאדט די זיכערע קארטל פעלדער…', other_ways: 'אנדערע וועגן צו געבן', teams: 'גרופעס', include_id: 'מאכט זיכער צו שרייבן די קאמפעין נומער',
    checks: 'טשעקס צו', zelle: 'Zelle', ein: 'EIN', wall: 'לעצטע נדבנים', anonymous: 'אנאנים', thanks: 'א דאנק פאר אייער נדבה צו',
    charged: 'באצאלט', receipt: 'שיקט מיר א קבלה', receipt_sent: 'א דאנק. דער אפיס וועט אייך שיקן א קבלה.', another: 'נאך א נדבה',
    confirm: 'איר גייט געבן {amount}. ביטע באשטעטיגט אז דאס איז ריכטיג.', min: 'די קלענסטע נדבה דא איז {amount}.', choose: 'ביטע קלייבט א סכום.',
    unavailable: 'דער בלאט נעמט נישט יעצט קיין נדבות.', yes: 'יא', no: 'ניין', send: 'שיקן', secure: 'באשיצט דורך Sola Payments',
    required: 'פארלאנגט', test: 'טעסט: קיין אמת׳ע באצאלונג. ניצט קארטל 4111 1111 1111 1111.', robot: 'ביטע באשטעטיגט אז איר זענט נישט קיין ראבאט.',
    details: 'אייערע פרטים', read_more: 'לייענט מער', safe: 'אייערע קארטל פרטים גייען גלייך צום באצאלונג פראצעסאר. מיר זעען און האלטן זיי נישט.', of_goal: 'פון {goal} ציל',
  },
};
// ACH and DAF wording. English comes from PayMethods.
const PAY_T: Record<Lang, Record<string, string>> = {
  en: {
    debited: 'Your ACH payment will be debited within 1–3 business days.',
    no_repeat: 'Your gift went through, but it couldn\'t be set up to repeat. The office will be in touch.',
    test_other: 'Test mode: ACH account 999999999 with routing 021000021; OJC card 6900664467242419; Pledger card 6599973975864259; Donors Fund card 6599992999456587 (under $5).',
  },
  he: {
    pay_with: 'אמצעי תשלום', credit_card: 'כרטיס אשראי', bank: 'ACH', account_type: 'סוג חשבון', checking: 'עו״ש', savings: 'חיסכון',
    choose_one: 'בחרו', account_name: 'שם בעל החשבון', routing: 'מספר ניתוב (Routing)', routing2: 'הקלידו שוב את מספר הניתוב',
    account: 'מספר חשבון', account2: 'הקלידו שוב את מספר החשבון', ach_auth: 'הרשאה לחיוב חשבון (ACH)', download: 'הורדה',
    ach_agree: 'קראתי ואני מסכים להרשאה שלמעלה.', ach_agree_needed: 'נא לאשר את ההרשאה לחיוב החשבון.', routing_bad: 'בדקו את מספר הניתוב.',
    routing_mismatch: 'מספרי הניתוב אינם תואמים.', account_bad: 'בדקו את מספר החשבון.', account_mismatch: 'מספרי החשבון אינם תואמים.',
    type_needed: 'בחרו עו״ש או חיסכון.', name_needed: 'הזינו את שם בעל החשבון.', daf_card: 'מספר כרטיס {fund}', account_email: 'דוא״ל החשבון',
    daf_email: 'כתובת הדוא״ל שלכם ב-Donors Fund', pin: 'קוד PIN בן 4 ספרות', daf_bad: 'בדקו את מספר כרטיס {fund}.', exp_bad: 'הזינו תוקף בפורמט MM/YY.',
    cvv_bad: 'הזינו CVV.', email_pin_bad: 'הזינו את הדוא״ל ואת קוד ה-PIN של Donors Fund.',
    debited: 'חיוב ה-ACH יתבצע תוך 1–3 ימי עסקים.', no_repeat: 'התרומה התקבלה, אך לא ניתן היה להגדיר אותה כתרומה קבועה. המשרד ייצור קשר.',
  },
  yi: {
    pay_with: 'באצאל מיטל', credit_card: 'קרעדיט קארד', bank: 'ACH', account_type: 'סארט אקאונט', checking: 'טשעקינג', savings: 'סעיווינגס',
    choose_one: 'קלייבט', account_name: 'נאמען אויפן אקאונט', routing: 'ראוטינג נומער', routing2: 'שרייבט נאכאמאל דעם ראוטינג נומער',
    account: 'אקאונט נומער', account2: 'שרייבט נאכאמאל דעם אקאונט נומער', ach_auth: 'ACH ערלויבעניש', download: 'אראפלאדן',
    ach_agree: 'איך האב געליינט און בין מסכים צו דער ערלויבעניש אויבן.', ach_agree_needed: 'ביטע זייט מסכים צו דער ACH ערלויבעניש.',
    routing_bad: 'קוקט איבער דעם ראוטינג נומער.', routing_mismatch: 'די ראוטינג נומערן שטימען נישט.', account_bad: 'קוקט איבער דעם אקאונט נומער.',
    account_mismatch: 'די אקאונט נומערן שטימען נישט.', type_needed: 'קלייבט טשעקינג אדער סעיווינגס.', name_needed: 'שרייבט דעם נאמען אויפן אקאונט.',
    daf_card: '{fund} קארטל נומער', account_email: 'אקאונט אימעיל', daf_email: 'אייער Donors Fund אימעיל', pin: '4 ציפער PIN',
    daf_bad: 'קוקט איבער דעם {fund} קארטל נומער.', exp_bad: 'שרייבט די ביז-דאטום ווי MM/YY.', cvv_bad: 'שרייבט דעם CVV.',
    email_pin_bad: 'שרייבט אייער Donors Fund אימעיל און 4 ציפער PIN.',
    debited: 'אייער ACH באצאלונג וועט דורכגיין אין 1–3 ביזנעס טעג.', no_repeat: 'אייער נדבה איז דורך, אבער מען האט זי נישט געקענט איינשטעלן צו איבערחזר׳ן. דער אפיס וועט זיך פארבינדן.',
  },
};
const COUNTRIES = ['USA', 'Canada', 'Israel', 'England'];
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// The organization's own Turnstile site key when it has one, otherwise the platform's.
const PLATFORM_TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
// Payments go through the rate-limiting gate in front of the give function (workers/give-gate).
const GIVE_URL = (import.meta.env.VITE_GIVE_GATE_URL as string | undefined) || 'https://oizer-give-gate.smueller-cd9.workers.dev/';

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
  // Coming back to an open page brings the campaign's current details (name, goal, raised, teams...).
  useEffect(() => {
    const fresh = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', fresh);
    return () => document.removeEventListener('visibilitychange', fresh);
  }, [load]);

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
  const t: Record<string, string> = { ...PAY_EN, ...PAY_T.en, ...T[lang], ...PAY_T[lang] };
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
      <header className={`give-hero ${data.page.banner_url ? 'has-banner' : ''}`}
        style={data.page.banner_url ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.6)), url("${encodeURI(String(data.page.banner_url))}")` } : undefined}>
        <div className="give-hero-in">
          {/* The organization (with a bigger logo) on one side and its email and phone on the other (Moshe Henig, 2026-11-11). */}
          <div className="give-hero-top">
            <div className="give-org">
              {data.org.logo_url ? <img src={data.org.logo_url} alt="" /> : <span className="give-org-mark">{String(data.org.name ?? '?')[0]}</span>}
              <span dir="auto">{data.org.name}</span>
            </div>
            <OrgContact email={data.org.email} phone={data.org.phone} className="org-contact give-contact" />
          </div>
          <h1 dir="auto">{c.name}</h1>
        </div>
      </header>
      <main className="give-main">
        <aside className="give-side">
          {c.goal ? (
            <div className="give-card give-progress">
              <div className="give-raised" dir="auto"><b>{usd(Number(c.raised ?? 0))}</b> <span>{t.of_goal.replace('{goal}', usd(Number(c.goal)))}</span></div>
              <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
              <div className="give-pct">{pct}%</div>
            </div>
          ) : null}
          {data.page.description && <Story text={String(data.page.description)} more={t.read_more} />}
          {Array.isArray(data.page.donor_wall) && data.page.donor_wall.length > 0 && (
            <section className="give-card give-wall">
              <h2 dir="auto">{t.wall}</h2>
              <ul>{data.page.donor_wall.map((w: Row, i: number) => <li key={i}><span dir="auto">{w.name || t.anonymous}</span><b>{usd(Number(w.amount))}</b></li>)}</ul>
            </section>
          )}
          {/* The campaign's teams that are turned on for this page, each opening its own page (Moshe Henig, 2026-11-11). */}
          {Array.isArray(data.teams) && data.teams.length > 0 && (
            <section className="give-card give-teams">
              <h2 dir="auto">{t.teams}</h2>
              <ul>{data.teams.map((tm: Row) => <li key={tm.id}><a href={`/give/${encodeURIComponent(tm.id)}`} dir="auto">{tm.name}</a></li>)}</ul>
            </section>
          )}
          {(data.org.check_payee || data.org.zelle || data.org.ein) && (
            <section className="give-card give-other">
              <h2 dir="auto">{t.other_ways}</h2>
              {data.org.check_payee && <div dir="auto">{t.checks}: <b>{data.org.check_payee}</b></div>}
              {data.org.zelle && <div dir="auto">{t.zelle}: <b>{data.org.zelle}</b></div>}
              {data.org.ein && <div dir="auto">{t.ein}: <b>{data.org.ein}</b></div>}
              <p className="give-include-id" dir="auto">{t.include_id}: <b>{c.id}</b></p>
            </section>
          )}
        </aside>
        <div className="give-card give-form-card">
          {thanks ? (
            <Thanks t={t} data={data} result={thanks} onAgain={() => { setThanks(null); setRound(r => r + 1); void load(); }} />
          ) : !data.payments.ready || !(data.payments.turnstile_site_key || PLATFORM_TURNSTILE_KEY) ? (
            // Without a bot check the page can't take payments (the give function refuses them too).
            <p className="error" dir="auto">{t.unavailable}</p>
          ) : (
            <GiveForm key={round} t={t} data={data} orgId={orgId} onDone={setThanks} />
          )}
        </div>
      </main>
      <footer className="give-foot">
        <span className="give-lock" aria-hidden="true">🔒</span> {t.secure} · {data.org.name}
        <PoweredBy orgId={orgId} />
      </footer>
    </div>
  );
}

/** The campaign's story: a few lines, with the rest a click away. */
function Story({ text, more }: { text: string; more: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320;
  return (
    <section className="give-card give-story-card">
      <p className={`give-story ${long && !open ? 'clamped' : ''}`} dir="auto">{text}</p>
      {long && !open && <button type="button" className="give-more" onClick={() => setOpen(true)} dir="auto">{more}</button>}
    </section>
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
  const [method, setMethod] = useState<Method>('card');
  const [program, setProgram] = useState<string | null>(null);
  const [bank, setBank] = useState<BankValue>(emptyBank());
  const [daf, setDaf] = useState<DafValue>(emptyDaf());
  const L = t as unknown as PayLabels;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [human, setHuman] = useState<string | null>(null);
  const tokens = useRef<() => Promise<{ card: string; cvv: string }>>();
  const setTokens = useRef((get: () => Promise<{ card: string; cvv: string }>) => { tokens.current = get; }).current;
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstileId = useRef<string | null>(null);
  const TURNSTILE_KEY = (data.payments.turnstile_site_key as string | null) ?? PLATFORM_TURNSTILE_KEY;

  const todayIso = new Date().toLocaleDateString('en-CA');
  const [rec, setRec] = useState({ on: false, frequency: 'monthly' as 'weekly' | 'monthly' | 'quarterly' | 'annually', start: todayIso, fixed: true, count: '12', textMe: false, agreed: false });
  const chosen = other ? Number(other) : amount;
  useEffect(() => {
    if (!p.cover_fee || !cover || !(chosen && chosen > 0)) return setCoverTotal(null);
    const timer = window.setTimeout(() => {
      supabase.rpc('public_cover_fee', { p_org: orgId, p_campaign: data.campaign.id, p_amount: chosen, p_method: method === 'card' ? null : method === 'ach' ? 'ach' : program })
        .then(({ data: total }) => setCoverTotal(total != null ? Number(total) : null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chosen, cover, p.cover_fee, orgId, data.campaign.id, method, program]);
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
    if (!d.zip.trim()) return setError(`${zipLabel}: ${t.required}`);
    if (p.min && chosen < Number(p.min)) return setError(t.min.replace('{amount}', usd(Number(p.min))));
    if (rec.on && !rec.agreed) return setError(t.agree_needed);
    if (rec.on && rec.fixed && !(count && count >= 2)) return setError(t.payments);
    if (!confirmed && chosen > Number(p.confirm_over ?? 5000)) return setConfirming(true);
    setConfirming(false);
    const problem = method === 'ach' ? bankProblem(bank, L) : method === 'daf' ? dafProblem(program ?? '', daf, L) : expDigits.length !== 4 ? L.exp_bad : null;
    if (problem) return setError(problem);
    if (TURNSTILE_KEY && !human) return setError(t.robot);
    setBusy(true);
    try {
      const pay = method === 'ach' ? { ...bankBody(bank), ach_agreed: bank.agreed }
        : method === 'daf' ? dafBody(program!, daf)
        : await tokens.current!().then(card => ({ method: 'card', card_sut: card.card, cvv_sut: card.cvv, exp: expDigits }));
      // Through the rate-limiting gate (workers/give-gate), never straight to the give function.
      const res = await fetch(GIVE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org: orgId, campaign: data.campaign.id, amount: chosen, cover_fee: cover && !!p.cover_fee, donor: d, custom, ...pay, turnstile: human,
          // A fund's recurring grant starts today.
          recurring: rec.on ? { frequency: rec.frequency, start: method === 'daf' ? todayIso : rec.start, count, text_me: rec.textMe } : null,
        }),
      }).catch(() => null);
      if (!res) throw new Error('Something went wrong. Please check your connection and try again.');
      const r = await res.json().catch(() => null) as Row | null;
      if (!r) throw new Error('Something went wrong. Please try again.');
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
      {data.payments.sandbox && <p className="give-test" dir="auto">{method === 'card' ? t.test : t.test_other}</p>}
      <div className="give-part give-part-amount">
      <h2 className="give-step" dir="auto"><span>1</span>{t.amount}</h2>
      {presets.length > 0 && (
        <div className="give-presets">
          {presets.map(a => (
            <button type="button" key={a} className={`${amount === a && !other ? 'on' : ''} ${Number(p.suggested) === a ? 'suggested' : ''}`}
              onClick={() => { setAmount(a); setOther(''); }}>{usd(a)}</button>
          ))}
        </div>
      )}
      {p.allow_other && (
        <label className={`give-other-amount ${other ? 'on' : ''}`}>
          <span aria-hidden="true">$</span>
          <input type="number" inputMode="decimal" min={p.min ?? 1} step="0.01" placeholder={t.other} aria-label={t.other} value={other}
            onChange={e => setOther(e.target.value)} dir="ltr" />
        </label>
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
            {method !== 'daf' && <label className="field"><span dir="auto">{t.start}</span><input type="date" dir="ltr" min={todayIso} value={rec.start} onChange={e => setRec(r => ({ ...r, start: e.target.value }))} /></label>}
            <label className="field"><span dir="auto">{t.payments}</span>
              <select value={rec.fixed ? 'n' : 'until'} onChange={e => setRec(r => ({ ...r, fixed: e.target.value === 'n' }))}>
                <option value="n">{t.fixed}</option><option value="until">{t.until}</option>
              </select></label>
            {rec.fixed && <label className="field"><span dir="auto">#</span><input type="number" min={2} max={520} dir="ltr" value={rec.count} onChange={e => setRec(r => ({ ...r, count: e.target.value }))} /></label>}
          </div>
          {count && count >= 2 && chosen ? <p dir="auto"><b>{t.series.replace('{n}', String(count)).replace('{amount}', usd(total)).replace('{total}', usd(total * count))}</b></p> : null}
          <label className="inline-check"><input type="checkbox" checked={rec.textMe} onChange={e => setRec(r => ({ ...r, textMe: e.target.checked }))} /> <span dir="auto">{t.text_me}</span></label>
          <label className="inline-check"><input type="checkbox" checked={rec.agreed} onChange={e => setRec(r => ({ ...r, agreed: e.target.checked }))} /> <span dir="auto">{terms}</span></label>
        </div>
      )}

      </div>

      <div className="give-part give-part-details">
      <h2 className="give-step" dir="auto"><span>2</span>{t.details}</h2>
      <div className="give-grid">
        <div className="give-names wide">
          <label className="field"><span dir="auto">{t.first} *</span><input required dir="auto" value={d.first_name} onChange={set('first_name')} autoComplete="given-name" /></label>
          <label className="field"><span dir="auto">{t.last} *</span><input required dir="auto" value={d.last_name} onChange={set('last_name')} autoComplete="family-name" /></label>
        </div>
        <label className="field"><span dir="auto">{t.phone} *</span><input required type="tel" dir="ltr" value={d.phone} onChange={set('phone')} autoComplete="tel" /></label>
        <label className="field"><span dir="auto">{t.email}</span><input type="email" dir="ltr" value={d.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="field"><span dir="auto">{t.country}</span>
          <select value={d.country} onChange={set('country')}>{COUNTRIES.map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="field"><span dir="auto">{zipLabel} *</span><input required dir="ltr" value={d.zip} onChange={set('zip')} autoComplete="postal-code" /></label>
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

      </div>

      <div className="give-part give-part-pay">
      <h2 className="give-step" dir="auto"><span>3</span>{L.pay_with}</h2>
      <MethodTabs value={method} program={program} ach={!!data.payments.ach} daf={data.payments.daf ?? []} L={L}
        onChange={(m, prog) => { setMethod(m); setProgram(prog); setDaf(emptyDaf()); setError(null); }} />
      {method === 'card' && (
        <>
          <p className="give-safe" dir="auto"><span aria-hidden="true">🔒</span> {t.safe}</p>
          <CardFields ifieldsKey={data.payments.ifields_key} onTokens={setTokens} exp={exp} onExp={setExp} tall labels={{ card: t.card, cvv: t.cvv, exp: t.exp, loading: t.loading }} />
        </>
      )}
      {method === 'ach' && <BankFields value={bank} onChange={setBank} L={L} authorization={data.payments.ach_authorization} orgName={data.org.name} />}
      {method === 'daf' && program && <DafFields program={program} value={daf} onChange={setDaf} L={L} />}

      {TURNSTILE_KEY && <div ref={turnstileBox} className="give-turnstile" />}
      {chosen ? <div className="give-total" dir="auto">{t.total}: <b>{usd(total)}</b></div> : null}
      {confirming && (
        <div className="give-confirm" dir="auto">{t.confirm.replace('{amount}', usd(chosen ?? 0))}
          <div><button type="button" className="btn primary" onClick={() => submit(true)}>{t.yes}</button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>{t.no}</button></div></div>
      )}
      {error && <div className="error" dir="auto">{error}</div>}
      </div>
      <div className="give-submit-bar">
      <button type="submit" className="btn primary give-submit" disabled={busy || (method === 'card' && expDigits.length !== 4)}>{busy ? t.processing : `${t.donate}${chosen ? ` ${usd(total)}` : ''}`}</button>
      </div>
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
      {result.method === 'ach' && !result.scheduled && <p dir="auto">{t.debited}</p>}
      {result.recurring && result.recurring_set === false && <p className="error" dir="auto">{t.no_repeat}</p>}
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
