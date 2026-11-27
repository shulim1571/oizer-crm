import { useEffect, useId, useRef, useState } from 'react';
import { requestOrgId, supabase } from '../lib/supabase';

/** One suggested street address (from the address-suggest function, Azure Maps). */
export interface AddressSuggestion { street: string; city: string; state: string; zip: string; one_line: string; two_lines: string }

/** Wait this long after typing stops, and need this many characters, before asking (keeps Azure Maps in its free tier). */
export const SUGGEST_DELAY_MS = 300;
export const SUGGEST_MIN_CHARS = 3;

// Answers already given this visit, so going back over the same letters asks nothing new.
const cache = new Map<string, AddressSuggestion[]>();
// Once the function can't be reached (not deployed, or no key), stop asking for the rest of the visit.
let unavailable = false;
/** For tests. */
export const resetAddressSuggest = () => { cache.clear(); unavailable = false; };

type Answer = { suggestions: AddressSuggestion[]; error?: string };

/** Asks the address-suggest function; a refusal (a limit, signed out) comes back as a message, not an exception. */
export async function fetchSuggestions(query: string, campaign?: string): Promise<Answer> {
  const key = `${campaign ?? ''}|${query.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return { suggestions: hit };
  // On a payment page the campaign goes along: donors aren't signed in, and the page's own limits apply (Moshe, 2026-11-25).
  const { data, error } = await supabase.functions.invoke('address-suggest', { body: { org: requestOrgId(), query: query.trim(), ...(campaign ? { campaign } : {}) } });
  if (error) {
    // A refusal carries its reason in the reply; anything else means the function isn't there to ask.
    const said = await (error as { context?: Response }).context?.json?.().catch(() => null) as Answer | null;
    if (said?.error) return { suggestions: [], error: said.error };
    unavailable = true;
    return { suggestions: [] };
  }
  const answer = (data ?? { suggestions: [] }) as Answer;
  if (!answer.error) cache.set(key, answer.suggestions ?? []);
  return { suggestions: answer.suggestions ?? [], error: answer.error };
}

/**
 * A donor's address box with suggestions while typing (Shulim, 2026-11-25): after about 300 ms without typing and 3 or
 * more characters, it asks for matching US street addresses and lists up to five; picking one fills the street, city,
 * state and ZIP into the box ("123 Main St, Brooklyn NY 11219"). Arrow keys move through the list, Enter picks,
 * Escape closes. Nothing is looked up for an address that's only been loaded or picked, not typed.
 */
export default function AddressSuggest({ value, onChange, onPick, required, oneLine = true, placeholder, campaign }: {
  value: string; onChange: (v: string) => void; required?: boolean; oneLine?: boolean; placeholder?: string;
  /** On a campaign's public payment page: that campaign (the donor isn't signed in). */
  campaign?: string;
  /** Given the picked address in parts (separate street, city, state and ZIP boxes) instead of one line in the box. */
  onPick?: (s: AddressSuggestion) => void;
}) {
  const [list, setList] = useState<AddressSuggestion[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const typed = useRef(false);
  const asked = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    if (q.length < SUGGEST_MIN_CHARS || unavailable) { setList([]); setNote(null); setOpen(false); return; }
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      void fetchSuggestions(q, campaign).then(a => {
        if (mine !== asked.current) return;   // a later keystroke has already asked
        setList(a.suggestions); setNote(a.error ?? null); setSel(-1); setOpen(a.suggestions.length > 0 || !!a.error);
      });
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);

  function pick(s: AddressSuggestion) {
    typed.current = false;   // the picked address isn't looked up again
    asked.current++;
    if (onPick) onPick(s); else onChange(oneLine ? s.one_line : s.two_lines);
    setList([]); setNote(null); setOpen(false);
  }

  return (
    <div className="addr-suggest">
      <input
        value={value} required={required} placeholder={placeholder} autoComplete="off" role="combobox" aria-autocomplete="list"
        aria-expanded={open && list.length > 0} aria-controls={listId}
        aria-activedescendant={sel >= 0 ? `${listId}-${sel}` : undefined}
        onChange={e => { typed.current = true; onChange(e.target.value); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (!open || !list.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => (i + 1) % list.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => (i <= 0 ? list.length - 1 : i - 1)); }
          else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(list[sel]); }
          else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        }}
      />
      {open && (list.length > 0 || note) && (
        <ul className="ss-list addr-suggest-list" id={listId} role="listbox">
          {list.map((s, i) => (
            <li key={s.one_line} id={`${listId}-${i}`} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''}
              onMouseDown={e => { e.preventDefault(); pick(s); }}>
              <b>{s.street}</b> <span className="muted">{s.city} {s.state} {s.zip}</span>
            </li>
          ))}
          {note && <li className="muted small addr-suggest-note" role="presentation">{note}</li>}
        </ul>
      )}
    </div>
  );
}
