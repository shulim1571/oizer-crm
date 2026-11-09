import { useMemo } from 'react';

// Bank account (ACH) and DAF card fields, shared by the public payment page and the office. These numbers go
// to the payment function and on to Sola; nothing here keeps them.

export type Method = 'card' | 'ach' | 'daf';
export const DAF_PROGRAMS = ['OJC', 'Pledger', 'Matbia', 'Donors Fund'] as const;
// What each fund asks for, as on the organization's existing page.
const DAF_NEEDS: Record<string, { exp: boolean; cvv: boolean }> = {
  OJC: { exp: true, cvv: false }, Pledger: { exp: true, cvv: true }, Matbia: { exp: true, cvv: false }, 'Donors Fund': { exp: false, cvv: true },
};

export const PAY_EN = {
  pay_with: 'Payment method', credit_card: 'Credit Card', bank: 'Bank account',
  account_type: 'Account type', checking: 'Checking', savings: 'Savings', choose_one: 'Select one', account_name: 'Name on account',
  routing: 'Routing number', routing2: 'Re-enter routing number', account: 'Account number', account2: 'Re-enter account number',
  ach_auth: 'ACH authorization', download: 'Download', ach_agree: 'I have read and agree to the authorization above.',
  ach_agree_needed: 'Please agree to the ACH authorization.', routing_bad: 'Check the routing number.', routing_mismatch: 'The routing numbers don\'t match.',
  account_bad: 'Check the account number.', account_mismatch: 'The account numbers don\'t match.', type_needed: 'Choose checking or savings.',
  name_needed: 'Enter the name on the account.', daf_card: '{fund} card number', card: 'Card number', account_email: 'Account email',
  daf_email: 'Your Donors Fund email address', pin: '4-digit PIN', daf_bad: 'Check the {fund} card number.', exp_bad: 'Enter the expiry as MM/YY.',
  cvv_bad: 'Enter the CVV.', email_pin_bad: 'Enter your Donors Fund email and 4-digit PIN.', cvv: 'CVV',
};
export type PayLabels = typeof PAY_EN;

export interface BankValue { account_type: '' | 'Checking' | 'Savings'; account_name: string; routing: string; routing2: string; account: string; account2: string; agreed: boolean }
export const emptyBank = (name = ''): BankValue => ({ account_type: '', account_name: name, routing: '', routing2: '', account: '', account2: '', agreed: false });
export interface DafValue { mode: 'card' | 'email'; card: string; exp: string; cvv: string; email: string; pin: string }
export const emptyDaf = (): DafValue => ({ mode: 'card', card: '', exp: '', cvv: '', email: '', pin: '' });

const digits = (s: string) => s.replace(/\D/g, '');
export const routingOk = (r: string) => /^\d{9}$/.test(r) && [...r].reduce((s, d, i) => s + Number(d) * [3, 7, 1][i % 3], 0) % 10 === 0;
const formatExp = (v: string) => { const x = digits(v).slice(0, 4); return x.length > 2 ? `${x.slice(0, 2)}/${x.slice(2)}` : x; };

/** What's wrong with the bank details, if anything. `needAgreement` is off when the office records consent its own way. */
export function bankProblem(v: BankValue, L: PayLabels, needAgreement = true): string | null {
  if (!v.account_type) return L.type_needed;
  if (!v.account_name.trim()) return L.name_needed;
  if (!routingOk(digits(v.routing))) return L.routing_bad;
  if (digits(v.routing) !== digits(v.routing2)) return L.routing_mismatch;
  if (!/^\d{4,17}$/.test(digits(v.account))) return L.account_bad;
  if (digits(v.account) !== digits(v.account2)) return L.account_mismatch;
  if (needAgreement && !v.agreed) return L.ach_agree_needed;
  return null;
}
export const bankBody = (v: BankValue) => ({ method: 'ach', routing: digits(v.routing), account: digits(v.account), account_type: v.account_type, account_name: v.account_name.trim() });

export function dafProblem(program: string, v: DafValue, L: PayLabels): string | null {
  const need = DAF_NEEDS[program];
  if (program === 'Donors Fund' && v.mode === 'email') return /^\S+@\S+\.\S+$/.test(v.email.trim()) && /^\d{4}$/.test(v.pin) ? null : L.email_pin_bad;
  if (!/^\d{8,19}$/.test(digits(v.card))) return L.daf_bad.replace('{fund}', program);
  if (need?.exp && digits(v.exp).length !== 4) return L.exp_bad;
  if (need?.cvv && !/^\d{3,4}$/.test(v.cvv)) return L.cvv_bad;
  return null;
}
export const dafBody = (program: string, v: DafValue) => (program === 'Donors Fund' && v.mode === 'email'
  ? { method: 'daf', program, daf_email: v.email.trim(), daf_pin: v.pin }
  : { method: 'daf', program, daf_card: digits(v.card), daf_exp: DAF_NEEDS[program]?.exp ? digits(v.exp) : undefined, daf_cvv: DAF_NEEDS[program]?.cvv ? v.cvv : undefined });

/** The method buttons: Credit Card, Bank account, then each fund the organization takes. */
export function MethodTabs({ value, program, ach, daf, onChange, L }: {
  value: Method; program: string | null; ach: boolean; daf: string[]; onChange: (m: Method, program: string | null) => void; L: PayLabels;
}) {
  if (!ach && !daf.length) return null;
  const tab = (key: string, label: string, on: boolean, pick: () => void) =>
    <button type="button" key={key} className={on ? 'on' : ''} aria-pressed={on} onClick={pick}>{label}</button>;
  return (
    <div className="pay-methods" role="group" aria-label={L.pay_with}>
      {tab('card', L.credit_card, value === 'card', () => onChange('card', null))}
      {ach && tab('ach', L.bank, value === 'ach', () => onChange('ach', null))}
      {DAF_PROGRAMS.filter(p => daf.includes(p)).map(p => tab(p, p, value === 'daf' && program === p, () => onChange('daf', p)))}
    </div>
  );
}

export function BankFields({ value, onChange, L, authorization, orgName, needAgreement = true }: {
  value: BankValue; onChange: (v: BankValue) => void; L: PayLabels; authorization?: string | null; orgName?: string; needAgreement?: boolean;
}) {
  const set = <K extends keyof BankValue>(k: K) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value } as BankValue);
  const num = (k: 'routing' | 'routing2' | 'account' | 'account2', max: number) => (e: { target: { value: string } }) => onChange({ ...value, [k]: digits(e.target.value).slice(0, max) });
  const download = useMemo(() => (authorization ? URL.createObjectURL(new Blob([`${L.ach_auth}\n${orgName ?? ''}\n\n${authorization}\n`], { type: 'text/plain' })) : null), [authorization, orgName, L.ach_auth]);
  return (
    <div className="bank-fields">
      <div className="give-grid">
        <label className="field"><span dir="auto">{L.account_type} *</span>
          <select value={value.account_type} onChange={set('account_type')}>
            <option value="">{L.choose_one}</option><option value="Checking">{L.checking}</option><option value="Savings">{L.savings}</option>
          </select></label>
        <label className="field"><span dir="auto">{L.account_name} *</span><input dir="auto" value={value.account_name} onChange={set('account_name')} autoComplete="name" /></label>
        <label className="field"><span dir="auto">{L.routing} *</span><input dir="ltr" inputMode="numeric" autoComplete="off" value={value.routing} onChange={num('routing', 9)} /></label>
        <label className="field"><span dir="auto">{L.routing2} *</span><input dir="ltr" inputMode="numeric" autoComplete="off" value={value.routing2} onChange={num('routing2', 9)}
          onPaste={e => e.preventDefault()} /></label>
        <label className="field"><span dir="auto">{L.account} *</span><input dir="ltr" inputMode="numeric" autoComplete="off" value={value.account} onChange={num('account', 17)} /></label>
        <label className="field"><span dir="auto">{L.account2} *</span><input dir="ltr" inputMode="numeric" autoComplete="off" value={value.account2} onChange={num('account2', 17)}
          onPaste={e => e.preventDefault()} /></label>
      </div>
      {authorization && (
        <div className="ach-auth">
          <div className="ach-auth-head"><b dir="auto">{L.ach_auth}</b>{download && <a href={download} download="ach-authorization.txt">{L.download}</a>}</div>
          <p dir="auto">{authorization}</p>
          {needAgreement && (
            <label className="inline-check"><input type="checkbox" checked={value.agreed} onChange={e => onChange({ ...value, agreed: e.target.checked })} />
              <span dir="auto">{L.ach_agree}</span></label>
          )}
        </div>
      )}
    </div>
  );
}

// Donors Fund by account email and PIN is hidden until Sola confirms which fields carry them
// (sending them as card number and CVV gave "Invalid Trackdata", error 01465).
const DONORS_FUND_EMAIL = false;

export function DafFields({ program, value, onChange, L }: { program: string; value: DafValue; onChange: (v: DafValue) => void; L: PayLabels }) {
  const need = DAF_NEEDS[program] ?? { exp: true, cvv: false };
  const byEmail = DONORS_FUND_EMAIL && program === 'Donors Fund' && value.mode === 'email';
  return (
    <div className="daf-fields">
      {DONORS_FUND_EMAIL && program === 'Donors Fund' && (
        <div className="pay-methods small">
          <button type="button" className={value.mode === 'card' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'card' })}>{L.card}</button>
          <button type="button" className={value.mode === 'email' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'email' })}>{L.account_email}</button>
        </div>
      )}
      <div className="daf-row">
        {byEmail ? (
          <>
            <input className="wide" type="email" dir="ltr" autoComplete="email" aria-label={L.daf_email} placeholder={L.daf_email} value={value.email}
              onChange={e => onChange({ ...value, email: e.target.value })} />
            <input type="password" dir="ltr" inputMode="numeric" autoComplete="off" aria-label={L.pin} placeholder={L.pin} maxLength={4} value={value.pin}
              onChange={e => onChange({ ...value, pin: digits(e.target.value).slice(0, 4) })} />
          </>
        ) : (
          <>
            <input className="wide" dir="ltr" inputMode="numeric" autoComplete="off" aria-label={L.daf_card.replace('{fund}', program)}
              placeholder={L.daf_card.replace('{fund}', program)} value={value.card}
              onChange={e => onChange({ ...value, card: digits(e.target.value).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ') })} />
            {need.exp && <input dir="ltr" inputMode="numeric" autoComplete="off" aria-label="MM/YY" placeholder="MM/YY" maxLength={5} value={value.exp}
              onChange={e => onChange({ ...value, exp: formatExp(e.target.value) })} />}
            {need.cvv && <input dir="ltr" inputMode="numeric" autoComplete="off" aria-label={L.cvv} placeholder={L.cvv} maxLength={4} value={value.cvv}
              onChange={e => onChange({ ...value, cvv: digits(e.target.value).slice(0, 4) })} />}
          </>
        )}
      </div>
    </div>
  );
}

/** A saved card or account as the office sees it. */
export const savedLabel = (k: { method?: string; card_type?: string | null; masked?: string | null; daf_program?: string | null }) => {
  const last4 = String(k.masked ?? '').slice(-4);
  if (k.method === 'ach') return `${k.card_type ?? 'Bank'} account ending ${last4}`;
  if (k.method === 'daf') return `${k.daf_program ?? k.card_type ?? 'DAF'} card ending ${last4}`;
  return `${k.card_type ?? 'Card'} ending ${last4}`;
};
