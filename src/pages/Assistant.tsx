import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HelpCircle, Send, Sparkles, X } from 'lucide-react';
import SettingsSection from '../components/SettingsSection';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// The AI help assistant (Shulim, 2026-11-11). Staff ask how-to questions; the assistant function answers from the
// app's guide with Claude. Version 1 sees no records. Each organization's admins set it up here.

export const ASSISTANT_MODELS = [
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest, default)', inUsd: 0.1, outUsd: 0.5 },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inUsd: 2, outUsd: 10 },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable, most expensive)', inUsd: 4, outUsd: 20 },
];

/** Rough cost of the logged usage, in dollars: input, cache writes at 1.25x, cache reads at 0.1x, output. */
export function usageCost(r: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }) {
  const m = ASSISTANT_MODELS.find(x => x.value === r.model);
  if (!m) return null;
  const perTok = (usd: number) => usd / 1_000_000;
  return Number(r.input_tokens) * perTok(m.inUsd) + Number(r.cache_write_tokens) * perTok(m.inUsd * 1.25)
    + Number(r.cache_read_tokens) * perTok(m.inUsd * 0.1) + Number(r.output_tokens) * perTok(m.outUsd);
}

/** Admins: on/off, model, length cap, daily limit, and the organization's own key (write-only). */
export function AssistantSettings() {
  const s = useQuery(async () => (((await supabase.rpc('ai_settings')).data ?? []) as Row[])[0] ?? null, []);
  const usage = useQuery(async () => ((await supabase.rpc('ai_usage_summary')).data ?? []) as Row[], []);
  const [v, setV] = useState({ enabled: false, model: 'claude-haiku-5-5', max_tokens: 600, daily_limit: 20 });
  const [key, setKey] = useState('');
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const cur = s.data as Row | null | undefined;
  useEffect(() => { if (cur) setV({ enabled: cur.enabled, model: cur.model, max_tokens: cur.max_tokens, daily_limit: cur.daily_limit }); }, [cur]);

  async function saveKey(clear = false) {
    setKeyMsg(null);
    if (clear && !confirm('Remove the organization’s own key? The assistant will use the shared key instead, if one is set.')) return;
    const { error } = await supabase.rpc('set_ai_key', { p_key: clear ? null : key });
    setKey('');
    setKeyMsg(error ? { ok: false, text: error.message } : { ok: true, text: clear ? 'Removed.' : 'Saved. It won’t be shown again.' });
    s.reload();
  }

  return (
    <>
      <SettingsSection title={<><Sparkles size={16} /> AI help assistant {cur?.enabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}</>}
        description="A Help button for signed-in staff that answers how-to questions about Oizer. It can’t see or change donors, donations, bank lines or any other records, and questions aren’t stored."
        saveLabel="Save assistant settings"
        onSave={async () => {
          const { error } = await supabase.rpc('save_ai_settings', { p_enabled: v.enabled, p_model: v.model, p_max_tokens: Number(v.max_tokens), p_daily_limit: Number(v.daily_limit) });
          s.reload();
          return error?.message ?? null;
        }}>
        <div className="fields">
          <label className="field check"><span>Turn on the Help button for staff</span><input type="checkbox" checked={v.enabled} onChange={e => setV({ ...v, enabled: e.target.checked })} /></label>
          <label className="field"><span>Model</span>
            <select value={v.model} onChange={e => setV({ ...v, model: e.target.value })}>{ASSISTANT_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
          <label className="field"><span>Longest answer (tokens)</span><input type="number" min={150} max={4000} value={v.max_tokens} onChange={e => setV({ ...v, max_tokens: Number(e.target.value) })} />
            <small className="muted">600 is about 450 words. Lower is cheaper.</small></label>
          <label className="field"><span>Questions per person per day</span><input type="number" min={1} max={500} value={v.daily_limit} onChange={e => setV({ ...v, daily_limit: Number(e.target.value) })} /></label>
        </div>
      </SettingsSection>

      <SettingsSection title="Your own Anthropic API key (optional)"
        description={cur?.own_key_set
          ? <>A key is saved{cur.key_set_by ? <> by {cur.key_set_by}</> : null}{cur.key_set_at ? <> on {dateTime(cur.key_set_at)}</> : null}. It’s kept encrypted and is never shown again. Questions are billed to it.</>
          : 'Without one, the assistant uses Oizer’s shared key. A key saved here is kept encrypted and never shown again.'}>
        <div className="fields">
          <label className="field wide"><span>{cur?.own_key_set ? 'Replace the key' : 'API key'}</span>
            <input type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={e => setKey(e.target.value)} /></label>
        </div>
        {keyMsg && <div className={keyMsg.ok ? 'notice' : 'error'}>{keyMsg.text}</div>}
        <div className="form-actions">
          {cur?.own_key_set && <button type="button" className="btn danger" onClick={() => saveKey(true)}>Remove key</button>}
          <div className="spacer" />
          <button type="button" className="btn primary" disabled={!key.trim()} onClick={() => saveKey()}>Save key</button>
        </div>
      </SettingsSection>

      {(usage.data ?? []).length > 0 && (
        <SettingsSection title="Assistant usage" description="Answered questions and an estimate of what they cost at list prices.">
          <table className="grid"><thead><tr><th>Period</th><th>Model</th><th className="right">Questions</th><th className="right">Estimated cost</th></tr></thead>
            <tbody>{(usage.data as Row[]).map(r => (
              <tr key={r.period + r.model}><td>{r.period}</td><td>{r.model}</td><td className="right">{r.questions}</td>
                <td className="right">{usageCost(r as never) == null ? '—' : `$${usageCost(r as never)!.toFixed(4)}`}{Number(r.own_key_questions) > 0 ? ' (own key)' : ''}</td></tr>
            ))}</tbody></table>
        </SettingsSection>
      )}
    </>
  );
}

/** The screen someone is on, without record ids: #/campaigns/1001 -> /campaigns/:id. */
export const currentScreen = () => (window.location.hash.replace(/^#/, '') || '/').split('?')[0].split('/').map(s => (/\d/.test(s) ? ':id' : s)).join('/').slice(0, 80);

/** The Help button and chat panel, for signed-in staff when the organization has the assistant on. */
export function HelpAssistant() {
  const { canWork } = useAuth();
  const avail = useQuery(async () => (canWork ? (((await supabase.rpc('ai_available')).data ?? []) as Row[])[0] ?? null : null), [canWork]);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);
  const a = avail.data as Row | null | undefined;
  if (!canWork || !a?.enabled) return null;
  const left = remaining ?? a.remaining;

  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    const next = [...turns, { role: 'user' as const, content: text }];
    setTurns(next); setQ(''); setBusy(true); setError(null);
    const { data, error: err } = await supabase.functions.invoke('assistant', { body: { org: requestOrgId(), messages: next, page: currentScreen() } });
    setBusy(false);
    if (err || data?.error) { setError(data?.error ?? 'The assistant didn’t answer. Try again.'); return; }
    setTurns([...next, { role: 'assistant', content: String(data.answer) }]);
    if (typeof data.remaining === 'number') setRemaining(data.remaining);
  }

  return (
    <>
      {!open && <button type="button" className="help-fab" onClick={() => setOpen(true)} aria-label="Help"><HelpCircle size={20} /> Help</button>}
      {open && (
        <div className="help-panel" role="dialog" aria-label="Help assistant">
          <div className="help-head"><b><Sparkles size={15} /> Help</b><span className="muted small">{left} question{left === 1 ? '' : 's'} left today</span>
            <button type="button" className="icon-btn" title="Close" onClick={() => setOpen(false)}><X size={16} /></button></div>
          <div className="help-body">
            {turns.length === 0 && <p className="muted small">Ask how to do something in Oizer, like “How do I print a check?” or “Where do I set a campaign’s PIN?”. The assistant can’t see your records. Answers can be wrong; check with the office if unsure.</p>}
            {turns.map((t, i) => <div key={i} className={`help-msg ${t.role}`}>{t.content}</div>)}
            {busy && <div className="help-msg assistant muted">Thinking…</div>}
            {error && <div className="error">{error}</div>}
            <div ref={end} />
          </div>
          <form className="help-ask" onSubmit={ask}>
            <input value={q} onChange={e => setQ(e.target.value)} maxLength={1000} placeholder={left > 0 ? 'Ask a question…' : 'Daily limit reached'} disabled={left <= 0} aria-label="Question" />
            <button className="btn primary" disabled={busy || !q.trim() || left <= 0} aria-label="Send"><Send size={15} /></button>
          </form>
        </div>
      )}
    </>
  );
}
