import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Megaphone, Mic, Pin, Play, Plus, Radio, Send, Square, Trash2, Users, X } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { campaignOptions, managerOptions, type Option } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';
import { Overlay } from './Pledges';

// Messages inside the portal: each fundraiser's conversation with the office, campaign group chats,
// voice messages, quick replies, one pinned announcement and broadcasts. Polled every 15 seconds.

const POLL = 15000;
export const inboxChanged = () => window.dispatchEvent(new Event('inbox-changed'));

/** Unread messages for the header and menu, kept current while the portal is open. */
export function useUnreadMessages(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const load = () => supabase.rpc('unread_message_count').then(({ data }) => setCount(Number(data ?? 0)));
    load();
    const timer = window.setInterval(load, 60000);
    window.addEventListener('inbox-changed', load);
    return () => { window.clearInterval(timer); window.removeEventListener('inbox-changed', load); };
  }, [enabled]);
  return count;
}

const time = (at: string) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : dateTime(at);
};
const linkify = (s: string) => s.split(/(https?:\/\/[^\s]+)/g).map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : p));

export default function InboxPage() {
  const { isAdmin } = useAuth();
  const { threadId } = useParams();
  const nav = useNavigate();
  const [threads, setThreads] = useState<Row[]>([]);
  const [announcement, setAnnouncement] = useState<Row | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'new' | 'group' | 'broadcast' | 'announce' | 'replies' | null>(null);

  const loadThreads = useCallback(async () => {
    const [t, a] = await Promise.all([
      supabase.rpc('my_threads'),
      supabase.from('announcements').select('*').is('removed_at', null).maybeSingle(),
    ]);
    setThreads((t.data ?? []) as Row[]);
    setAnnouncement(a.data as Row | null);
  }, []);
  useEffect(() => {
    void loadThreads();
    const timer = window.setInterval(loadThreads, POLL);
    window.addEventListener('inbox-changed', loadThreads);
    return () => { window.clearInterval(timer); window.removeEventListener('inbox-changed', loadThreads); };
  }, [loadThreads]);

  // A fundraiser with one conversation goes straight to it.
  useEffect(() => {
    if (!threadId && !isAdmin && threads.length === 1 && window.innerWidth > 800) nav(`/inbox/${threads[0].id}`, { replace: true });
  }, [threadId, isAdmin, threads, nav]);

  const shown = threads.filter(t => (!onlyUnread || t.unread > 0) && (!search || String(t.title).toLowerCase().includes(search.toLowerCase())));
  const current = threads.find(t => t.id === threadId);
  return (
    <section className={`view inbox ${threadId ? 'has-thread' : ''}`}>
      <div className="view-head">
        <div className="view-title"><h1>Messages</h1><span className="count">{isAdmin ? 'Conversations with fundraisers' : 'Your conversations with the office'}</span></div>
        {isAdmin && (
          <div className="view-actions">
            <button type="button" className="btn" onClick={() => setDialog('new')}><Plus size={15} /> New conversation</button>
            <button type="button" className="btn" onClick={() => setDialog('group')}><Users size={15} /> Group chat</button>
            <button type="button" className="btn" onClick={() => setDialog('broadcast')}><Radio size={15} /> Broadcast</button>
            <button type="button" className="btn" onClick={() => setDialog('announce')}><Megaphone size={15} /> Announcement</button>
            <button type="button" className="btn" onClick={() => setDialog('replies')}>Quick replies</button>
          </div>
        )}
      </div>
      {announcement && (
        <div className="announcement"><Pin size={16} /><div><b>Announcement</b> · {dateTime(announcement.posted_at)}<p>{linkify(announcement.body)}</p></div></div>
      )}
      <div className="inbox-panes">
        <div className="thread-list">
          <div className="thread-filters">
            <input placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} />
            <label className="inline-check"><input type="checkbox" checked={onlyUnread} onChange={e => setOnlyUnread(e.target.checked)} /> Unread</label>
          </div>
          {shown.length === 0 && <p className="muted small pad">{isAdmin ? 'No conversations yet. Start one, or wait for a fundraiser to write.' : 'Nothing here yet.'}</p>}
          {shown.map(t => (
            <Link key={t.id} to={`/inbox/${t.id}`} className={`thread-row ${t.id === threadId ? 'active' : ''} ${t.unread > 0 ? 'unread' : ''}`}>
              <div className="thread-top"><b>{t.title}</b>{t.unread > 0 && <span className="nav-count">{t.unread}</span>}</div>
              <div className="muted small">{t.last_preview ? `${t.last_from}: ${t.last_preview}` : 'No messages yet'}</div>
              {t.last_message_at && <div className="muted small">{time(t.last_message_at)}</div>}
            </Link>
          ))}
        </div>
        <div className="thread-pane">
          {threadId ? <Conversation key={threadId} threadId={threadId} thread={current} onChanged={loadThreads} />
            : <p className="muted pad">Choose a conversation.</p>}
        </div>
      </div>
      {dialog === 'new' && <PickDialog title="New conversation" label="Fundraiser" load={managerOptions} onClose={() => setDialog(null)}
        onPick={async v => { const { data, error } = await supabase.rpc('open_direct_thread', { p_manager: v }); if (error) throw error; nav(`/inbox/${data}`); }} />}
      {dialog === 'group' && <PickDialog title="Campaign group chat" label="Campaign" load={campaignOptions} onClose={() => setDialog(null)}
        note="Turns on the group chat for everyone on that campaign's team, and the office."
        onPick={async v => { const { data, error } = await supabase.rpc('set_group_chat', { p_campaign: v, p_enabled: true }); if (error) throw error; await loadThreads(); nav(`/inbox/${data}`); }} />}
      {dialog === 'broadcast' && <BroadcastDialog onClose={() => setDialog(null)} onSent={() => { setDialog(null); void loadThreads(); }} />}
      {dialog === 'announce' && <AnnouncementDialog current={announcement} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void loadThreads(); }} />}
      {dialog === 'replies' && <QuickRepliesDialog onClose={() => setDialog(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------
function Conversation({ threadId, thread, onChanged }: { threadId: string; thread?: Row; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState<Row[] | null>(null);
  const [text, setText] = useState('');
  const [replies, setReplies] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('thread_history', { p_thread: threadId });
    if (e) return setError(e.message);
    setItems(prev => {
      const next = (data ?? []) as Row[];
      if (!prev || next.length !== prev.length) setTimeout(() => end.current?.scrollIntoView({ block: 'end' }), 0);
      return next;
    });
    await supabase.rpc('mark_thread_read', { p_thread: threadId });
    inboxChanged();
  }, [threadId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, POLL);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (isAdmin) supabase.from('quick_replies').select('*').order('sort').then(({ data }) => setReplies((data ?? []) as Row[]));
  }, [isAdmin]);

  async function send(body: string, voice?: { data: string; mime: string; seconds: number }) {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('post_message', {
      p_thread: threadId, p_body: body || null, p_voice: voice?.data ?? null, p_voice_mime: voice?.mime ?? null, p_voice_seconds: voice?.seconds ?? null,
    });
    setBusy(false);
    if (e) return setError(e.message);
    setText('');
    await load();
    onChanged();
  }
  async function toggleGroup() {
    if (!thread?.campaign_id) return;
    if (thread.enabled && !confirm('Turn off this group chat? Fundraisers stop seeing it; the history is kept.')) return;
    const { error: e } = await supabase.rpc('set_group_chat', { p_campaign: thread.campaign_id, p_enabled: !thread.enabled });
    if (e) return setError(e.message);
    onChanged();
  }

  return (
    <div className="conversation">
      <div className="conversation-head">
        <button type="button" className="icon-btn back-btn" title="Back" onClick={() => nav('/inbox')}><ArrowLeft size={18} /></button>
        <b>{thread?.title ?? 'Conversation'}</b>
        {thread?.kind === 'group' && <Pill tone="blue">Group</Pill>}
        <div className="spacer" />
        {isAdmin && thread?.kind === 'direct' && thread.manager_id && <Link className="small" to={`/managers/${encodeURIComponent(thread.manager_id)}`}>Fundraiser record</Link>}
        {isAdmin && thread?.kind === 'group' && <button type="button" className="btn" onClick={toggleGroup}>{thread.enabled ? 'Turn off group chat' : 'Turn on group chat'}</button>}
      </div>
      <div className="bubbles">
        {items?.length === 0 && <p className="muted small pad">No messages yet. Say hello.</p>}
        {items?.map(m => (
          <div key={m.id} className={`bubble ${m.mine ? 'mine' : ''} ${m.from_office ? 'office' : ''}`}>
            <div className="bubble-meta">{m.sender_name}{m.broadcast && <> · <Pill>Broadcast</Pill></>} · {time(m.created_at)}</div>
            {m.voice_seconds && <VoicePlayer messageId={m.id} seconds={m.voice_seconds} downloadable={isAdmin} />}
            {m.body && <div className="bubble-body">{linkify(m.body)}</div>}
            {m.mine && <div className="bubble-read">{m.read_at ? `Read ${time(m.read_at)}` : 'Sent'}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {error && <div className="error">{error}</div>}
      {(thread?.enabled ?? true) && (
        <div className="composer">
          {isAdmin && replies.length > 0 && (
            <select className="quick-replies" value="" onChange={e => setText(t => (t ? `${t} ` : '') + e.target.value)} title="Quick replies">
              <option value="">Quick reply…</option>{replies.map(r => <option key={r.id} value={r.body}>{r.body}</option>)}
            </select>
          )}
          <textarea rows={2} value={text} placeholder="Write a message" onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) { e.preventDefault(); void send(text.trim()); } }} />
          <Recorder disabled={busy} onRecorded={v => send(text.trim(), v)} onError={setError} />
          <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={() => send(text.trim())}><Send size={15} /> Send</button>
        </div>
      )}
    </div>
  );
}

function VoicePlayer({ messageId, seconds, downloadable }: { messageId: string; seconds: number; downloadable: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [mime, setMime] = useState('audio/webm');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function fetchIt() {
    const { data } = await supabase.rpc('voice_note', { p_message: messageId });
    const v = ((data ?? []) as Row[])[0];
    if (!v) return;
    const bytes = Uint8Array.from(atob(v.data), c => c.charCodeAt(0));
    setMime(v.mime);
    setUrl(URL.createObjectURL(new Blob([bytes], { type: v.mime })));
  }
  const len = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return url ? (
    <div className="voice"><audio src={url} controls autoPlay />
      {downloadable && <a className="icon-btn" href={url} download={`voice-${messageId}.${mime.includes('mp4') ? 'm4a' : 'webm'}`} title="Download"><Download size={15} /></a>}</div>
  ) : <button type="button" className="btn voice" onClick={fetchIt}><Play size={15} /> Voice message · {len}</button>;
}

/** Hold to record, release to send. Stops by itself at two minutes. */
function Recorder({ disabled, onRecorded, onError }: { disabled: boolean; onRecorded: (v: { data: string; mime: string; seconds: number }) => void; onError: (m: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; started: number; timer: number; cancelled: boolean } | null>(null);

  async function start() {
    if (disabled || rec.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return onError('This browser can\'t record. Try Chrome or Safari.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      const state = { recorder, chunks: [] as Blob[], started: Date.now(), timer: 0, cancelled: false };
      recorder.ondataavailable = e => { if (e.data.size) state.chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        window.clearInterval(state.timer);
        rec.current = null;
        setRecording(false);
        const seconds = Math.min(120, Math.round((Date.now() - state.started) / 1000));
        if (state.cancelled || seconds < 1) return;
        const blob = new Blob(state.chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        const reader = new FileReader();
        reader.onload = () => onRecorded({ data: String(reader.result).split(',')[1] ?? '', mime: blob.type, seconds });
        reader.readAsDataURL(blob);
      };
      state.timer = window.setInterval(() => {
        const s = Math.round((Date.now() - state.started) / 1000);
        setElapsed(s);
        if (s >= 120) recorder.stop();
      }, 250);
      rec.current = state;
      setElapsed(0);
      setRecording(true);
      recorder.start();
    } catch {
      onError('Allow the microphone to record a voice message.');
    }
  }
  const stop = () => rec.current?.recorder.state === 'recording' && rec.current.recorder.stop();
  const cancel = () => { if (rec.current) { rec.current.cancelled = true; stop(); } };

  return (
    <>
      {recording && <span className="recording"><span className="dot" /> {elapsed}s · release to send <button type="button" className="link" onPointerDown={e => e.stopPropagation()} onClick={cancel}>cancel</button></span>}
      <button type="button" className={`icon-btn outlined mic ${recording ? 'on' : ''}`} title="Hold to record a voice message" disabled={disabled}
        onPointerDown={e => { e.preventDefault(); void start(); }} onPointerUp={stop} onPointerLeave={stop} onContextMenu={e => e.preventDefault()}>
        {recording ? <Square size={16} /> : <Mic size={16} />}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Admin dialogs
// ---------------------------------------------------------------------------
function PickDialog({ title, label, note, load, onPick, onClose }: { title: string; label: string; note?: string; load: () => Promise<Option[]>; onPick: (v: string) => Promise<void>; onClose: () => void }) {
  const [options, setOptions] = useState<Option[]>([]);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void load().then(setOptions); }, [load]);
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{title}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>{label}</span><SearchSelect value={value} options={options} onChange={setValue} /></label>
      {note && <p className="muted small">{note}</p>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!value} onClick={() => value && onPick(value).then(onClose, e => setError(e.message))}>Open</button></div>
    </Overlay>
  );
}

function BroadcastDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [audience, setAudience] = useState<'all' | 'primary' | 'chosen'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [managers, setManagers] = useState<Option[]>([]);
  const [past, setPast] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void managerOptions().then(setManagers);
    supabase.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(50).then(({ data }) => setPast((data ?? []) as Row[]));
  }, []);
  async function send() {
    if (!confirm('Send this broadcast? It lands in each fundraiser\'s messages and is emailed to them.')) return;
    const { error: e } = await supabase.rpc('send_broadcast', { p_audience: audience, p_body: body, p_managers: audience === 'chosen' ? chosen : null });
    if (e) return setError(e.message);
    onSent();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Broadcast</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>Send to</span>
        <select value={audience} onChange={e => setAudience(e.target.value as typeof audience)}>
          <option value="all">All fundraisers</option><option value="primary">Primary fundraisers only</option><option value="chosen">Fundraisers I choose</option>
        </select></label>
      {audience === 'chosen' && (
        <div className="pick-list">{managers.map(m => (
          <label key={m.value} className="inline-check"><input type="checkbox" checked={chosen.includes(m.value)}
            onChange={e => setChosen(c => (e.target.checked ? [...c, m.value] : c.filter(x => x !== m.value)))} /> {m.label}</label>
        ))}</div>
      )}
      <label className="field wide"><span>Message</span><textarea rows={4} value={body} onChange={e => setBody(e.target.value)} /></label>
      <p className="muted small">Each fundraiser gets it in their conversation with the office and can reply there.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!body.trim() || (audience === 'chosen' && !chosen.length)} onClick={send}><Send size={15} /> Send broadcast</button></div>
      {past.length > 0 && (
        <>
          <h3 className="section-title">Past broadcasts</h3>
          <div className="table-wrap dialog-table"><table className="grid">
            <thead><tr><th>When</th><th>By</th><th>To</th><th>Message</th></tr></thead>
            <tbody>{past.map(b => <tr key={b.id}><td>{dateTime(b.created_at)}</td><td>{b.created_by}</td>
              <td>{b.recipient_count} · {b.audience === 'all' ? 'all' : b.audience === 'primary' ? 'primaries' : 'chosen'}</td><td>{b.body}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
    </Overlay>
  );
}

function AnnouncementDialog({ current, onClose, onDone }: { current: Row | null; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState(current?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  async function post() {
    if (!confirm('Pin this for every fundraiser? It replaces the current announcement and is emailed to all active fundraisers.')) return;
    const { error: e } = await supabase.rpc('post_announcement', { p_body: body });
    if (e) return setError(e.message);
    onDone();
  }
  async function remove() {
    const { error: e } = await supabase.rpc('remove_announcement');
    if (e) return setError(e.message);
    onDone();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Pinned announcement</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field wide"><span>Announcement</span><textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="New payout process starting Monday" /></label>
      <p className="muted small">Shown at the top of every fundraiser's messages until you change or remove it. They can't dismiss it.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        {current && <button type="button" className="btn danger" onClick={remove}><Trash2 size={15} /> Remove</button>}
        <div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!body.trim() || body.trim() === current?.body} onClick={post}><Pin size={15} /> Pin</button></div>
    </Overlay>
  );
}

function QuickRepliesDialog({ onClose }: { onClose: () => void }) {
  const { isSuperAdmin } = useAuth();
  const [list, setList] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => supabase.from('quick_replies').select('*').order('sort').then(({ data }) => setList((data ?? []) as Row[]));
  useEffect(() => { void load(); }, []);
  async function add() {
    const { error: e } = await supabase.rpc('save_quick_reply', { p_id: null, p_body: text, p_sort: list.length + 1 });
    if (e) return setError(e.message);
    setText('');
    void load();
  }
  async function remove(id: string) {
    const { error: e } = await supabase.rpc('delete_quick_reply', { p_id: id });
    if (e) return setError(e.message);
    void load();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Quick replies</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">Ready-made replies every admin can pick in a conversation. Only the Super Admin can change them.</p>
      <ul className="plain-list">{list.map(r => (
        <li key={r.id}>{r.body}{isSuperAdmin && <button type="button" className="icon-btn" title="Remove" onClick={() => remove(r.id)}><Trash2 size={14} /></button>}</li>
      ))}</ul>
      <div className="fields"><label className="field wide"><span>Add a reply</span><input value={text} onChange={e => setText(e.target.value)} /></label></div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" disabled={!text.trim()} onClick={add}>Add</button></div>
    </Overlay>
  );
}
