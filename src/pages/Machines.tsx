import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import DateNote from '../components/DateNote';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, localToday } from '../lib/format';
import { campaignOptions, clearLookups, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

type Tone = 'green' | 'amber' | 'blue' | '';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'blue' },
  confirmed: { label: 'Confirmed', tone: 'green' },
  waitlisted: { label: 'Waitlisted', tone: 'amber' },
  cancelled: { label: 'Cancelled', tone: '' },
};
export const BookingPill = ({ status }: { status: string }) => <Pill tone={STATUS[status]?.tone ?? ''}>{STATUS[status]?.label ?? status}</Pill>;
const machineLabel = (r: Row) => (r.machine_nickname != null ? `Machine ${r.machine_nickname}` : '');

/** Machines free on a day, for the admin to choose from. Keeps the one already given to this booking. */
function useFreeMachines(date: string, version: number, keep?: string | null) {
  const q = useQuery(async () => {
    const [{ data: machines }, { data: taken }] = await Promise.all([
      supabase.from('machines').select('id, nickname').eq('active', true).order('nickname'),
      supabase.from('machine_bookings').select('machine_id').eq('booking_date', date).eq('status', 'confirmed'),
    ]);
    const out = new Set((taken ?? []).map(t => t.machine_id));
    return (machines ?? []).filter(m => !out.has(m.id) || m.id === keep) as Row[];
  }, [date, version, keep]);
  return (q.data as Row[]) ?? [];
}

/** What an admin can do with one request. Used on the calendar and the Task Sheet. */
export function BookingActions({ booking, onAct, version = 0 }: {
  booking: Row;
  onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void;
  version?: number;
}) {
  const free = useFreeMachines(booking.booking_date, version, booking.machine_id);
  const [machine, setMachine] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    setMachine(booking.machine_id ?? free[0]?.id ?? '');
    setNote(booking.admin_notes ?? '');
  }, [booking.id, booking.machine_id, booking.admin_notes, free.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (booking.status === 'cancelled') return null;
  const waiting = booking.status === 'pending' || booking.status === 'waitlisted';
  const noteChanged = note !== (booking.admin_notes ?? '');
  const reasonThen = (question: string, run: (reason: string) => void) => {
    const reason = prompt(question);
    if (reason !== null) run(reason);
  };
  return (
    <div className="booking-actions">
      <select aria-label="Machine" value={machine} onChange={e => setMachine(e.target.value)}>
        {free.length === 0 && <option value="">No machine free</option>}
        {free.map(m => <option key={m.id} value={m.id}>Machine {m.nickname}</option>)}
      </select>
      <input aria-label="Note to the fundraiser" placeholder="Note, like when to bring it back" value={note} onChange={e => setNote(e.target.value)} />
      <button type="button" className="btn primary" disabled={!machine || (booking.status === 'confirmed' && machine === booking.machine_id)}
        onClick={() => onAct(supabase.rpc('confirm_booking', { p_booking: booking.id, p_machine: machine, p_note: note || null }), 'confirmed', note)}>
        {booking.status === 'confirmed' ? 'Change machine' : 'Confirm'}
      </button>
      {noteChanged && <button type="button" className="btn" onClick={() => onAct(supabase.rpc('set_booking_note', { p_booking: booking.id, p_note: note }), 'noted', note)}>Save note</button>}
      {booking.status === 'pending' && <button type="button" className="btn" onClick={() => onAct(supabase.rpc('waitlist_booking', { p_booking: booking.id, p_note: note || null }), 'waitlisted', note)}>Waitlist</button>}
      {waiting && (
        <>
          <button type="button" className="icon-btn" title="Move up in line" onClick={() => reasonThen('Why does this go ahead of an earlier request? A reason is required:', r => onAct(supabase.rpc('move_booking', { p_booking: booking.id, p_up: true, p_reason: r }), 'moved up', r))}><ArrowUp size={15} /></button>
          <button type="button" className="icon-btn" title="Move down in line" onClick={() => reasonThen('Why does this go behind a later request? A reason is required:', r => onAct(supabase.rpc('move_booking', { p_booking: booking.id, p_up: false, p_reason: r }), 'moved down', r))}><ArrowDown size={15} /></button>
        </>
      )}
      <button type="button" className="btn danger" onClick={() => reasonThen('Cancel this request? Add a reason if useful:', r => onAct(supabase.rpc('cancel_booking', { p_booking: booking.id, p_reason: r || null }), 'cancelled', r))}>Cancel request</button>
    </div>
  );
}

const availabilityText = (a: Row) => `${a.available} machine${a.available === 1 ? '' : 's'} available · ${a.booked} already booked · ${a.waitlisted} waitlisted`;

function RequestForm({ onDone }: { onDone: () => void }) {
  const [date, setDate] = useState(localToday());
  const [campaign, setCampaign] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Row | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { campaignOptions().then(setOptions); }, []);
  const a = useQuery(async () => {
    if (!date) return null;
    const { data, error: e } = await supabase.rpc('machine_availability', { p_from: date, p_to: date });
    if (e) throw new Error(e.message);
    return (data as Row[])[0] ?? null;
  }, [date, version]);

  async function submit() {
    setError(null);
    setPlaced(null);
    const { data, error: e } = await supabase.rpc('request_machine', { p_date: date, p_campaign: campaign, p_notes: notes });
    if (e) return setError(e.message);
    const { data: row } = await supabase.from('machine_booking_list').select('*').eq('id', data).maybeSingle();
    setPlaced(row);
    setNotes('');
    setVersion(v => v + 1);
    onDone();
  }

  return (
    <div className="card">
      <h3>Request a machine</h3>
      <div className="fields">
        <label className="field"><span>Date needed *</span>
          <input type="date" min={localToday()} value={date} onChange={e => { setDate(e.target.value); setPlaced(null); }} />
          <DateNote date={date} />
        </label>
        <label className="field"><span>Campaign *</span>
          <SearchSelect value={campaign} options={options} onChange={setCampaign} placeholder="Which campaign it's for…" required />
        </label>
      </div>
      <label className="field"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
      {a.data && <p className="muted small">{availabilityText(a.data as Row)}</p>}
      {(a.data as Row | null)?.available === 0 && <p className="muted small">Nothing is free that day, so this request goes on the waitlist.</p>}
      {error && <div className="error">{error}</div>}
      {placed && (
        <div className="notice">
          Request logged for {placed.booking_date}. You're number {placed.queue_position} in line that day
          {placed.status === 'waitlisted' ? ', on the waitlist.' : ', waiting for the office to assign a machine.'}
        </div>
      )}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={!date || !campaign} onClick={submit}>Submit request</button>
      </div>
    </div>
  );
}

export function MachinesPage() {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [showPast, setShowPast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('machine_booking_list').select('*').order('booking_date', { ascending: false }).order('queue_at').range(a, b) as never),
    [version],
  );
  const rows = ((q.data as Row[]) ?? []).filter(r => showPast || (!r.past && r.status !== 'cancelled'));

  async function cancel(r: Row) {
    const reason = prompt(`Cancel your machine request for ${r.booking_date}? Add a reason if useful:`);
    if (reason === null) return;
    const { error: e } = await supabase.rpc('cancel_booking', { p_booking: r.id, p_reason: reason || null });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
  }

  const columns: Column[] = [
    { key: 'booking_date', label: 'Date' },
    { key: 'status', label: 'Status', value: r => STATUS[r.status]?.label, render: r => <BookingPill status={r.status} /> },
    { key: 'machine_nickname', label: 'Machine', value: machineLabel },
    { key: 'queue_position', label: 'In line', optional: true, align: 'right' },
    { key: 'campaign', label: 'Campaign', value: r => `${r.campaign_name ?? ''} - ${r.campaign_id}`, width: 190 },
    ...(isAdmin ? [{ key: 'fundraiser', label: 'Fundraiser' }] : []),
    { key: 'notes', label: 'Notes', long: true },
    { key: 'admin_notes', label: 'From the office', long: true, width: 200 },
    { key: 'requested_at', label: 'Requested', optional: true, render: r => dateTime(r.requested_at) },
    { key: 'cancel', label: '', render: r => !r.past && r.status !== 'cancelled' && <button type="button" className="link" onClick={e => { e.stopPropagation(); cancel(r); }}>Cancel</button> },
  ];

  return (
    <section className="view">
      <RequestForm onDone={() => setVersion(v => v + 1)} />
      {error && <div className="error">{error}</div>}
      <DataTable
        title={isAdmin ? 'All bookings' : 'My bookings'}
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="machine-bookings"
        actions={<label className="inline-check"><input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} /> Show past and cancelled</label>}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The registry, in Settings
// ---------------------------------------------------------------------------
export function MachineRegistryPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery(async () => {
    const { data, error } = await supabase.from('machines').select('*, campaigns(internal_name, campaign_name, external_name)').order('active', { ascending: false }).order('nickname');
    if (error) throw new Error(error.message);
    return data as Row[];
  }, [version]);
  const name = (r: Row) => (r.campaign_id ? `${r.campaigns?.internal_name || r.campaigns?.campaign_name || r.campaigns?.external_name || ''} - ${r.campaign_id}` : '');
  const refresh = () => { clearLookups(); setVersion(v => v + 1); };
  return (
    <section className="view">
      <DataTable
        title="Donary machines"
        rows={q.data ?? []}
        loading={q.loading}
        error={q.error}
        exportName="donary-machines"
        onOpen={r => setOpen(r.id)}
        columns={[
          { key: 'nickname', label: 'Machine', value: r => `Machine ${r.nickname}` },
          { key: 'campaign', label: 'Campaign', value: r => name(r) || (r.active ? 'Unassigned' : ''), width: 240 },
          { key: 'active', label: 'Status', value: r => (r.active ? 'Active' : 'Retired'), render: r => <Pill tone={r.active ? 'green' : ''}>{r.active ? 'Active' : 'Retired'}</Pill> },
          { key: 'notes', label: 'Notes' },
        ]}
        actions={<button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> Register machine</button>}
      />
      {adding && <RegisterDialog onClose={() => setAdding(false)} onSaved={id => { setAdding(false); refresh(); setOpen(id); }} />}
      {open && <MachineDialog id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
    </section>
  );
}

function RegisterDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [donaryId, setDonaryId] = useState('');
  const [nickname, setNickname] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    const { data, error: e } = await supabase.rpc('register_machine', { p_donary_id: donaryId, p_nickname: nickname === '' ? null : Number(nickname), p_notes: notes || null });
    if (e) return setError(e.message);
    onSaved(data as string);
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Register a machine</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>Donary machine ID *</span><input value={donaryId} onChange={e => setDonaryId(e.target.value)} /></label>
      <label className="field"><span>Number</span><input type="number" min="1" step="1" value={nickname} placeholder="Leave empty for the next unused number" onChange={e => setNickname(e.target.value)} /></label>
      <label className="field"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <p className="muted small">A number that any machine has had is never used for a different one.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!donaryId.trim()} onClick={save}>Register</button></div>
    </Overlay>
  );
}

function MachineDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<'details' | 'assignments' | 'usage'>('details');
  const [options, setOptions] = useState<Option[]>([]);
  const [campaign, setCampaign] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [nickname, setNickname] = useState('');
  const [donaryId, setDonaryId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { campaignOptions().then(all => setOptions(all.filter(o => !/\((archived|draft)\)$/.test(o.label)))); }, []);
  const q = useQuery(async () => {
    const { data, error: e } = await supabase.from('machines').select('*').eq('id', id).maybeSingle();
    if (e) throw new Error(e.message);
    return data as Row;
  }, [id, version]);
  const m = q.data as Row | null;
  useEffect(() => {
    if (!m) return;
    setCampaign(m.campaign_id);
    setNickname(String(m.nickname));
    setDonaryId(m.donary_id);
    setNotes(m.notes ?? '');
  }, [m]);
  const history = useQuery(async () => (await supabase.from('machine_assignments').select('*').eq('machine_id', id).order('changed_at', { ascending: false })).data ?? [], [id, version]);
  const usage = useQuery(
    () => fetchAll((a, b) => supabase.from('machine_booking_list').select('*').eq('machine_id', id).order('booking_date', { ascending: false }).range(a, b) as never),
    [id, version],
  );

  async function run(call: PromiseLike<{ error: { message: string } | null }>) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    setReason('');
    setVersion(v => v + 1);
    onChanged();
  }
  if (!m) return null;
  const toRow = (r: Row, next?: Row) => ({
    ...r,
    until: next ? next.changed_at : null,
  });
  const entries = ((history.data as Row[]) ?? []).map((r, i, all) => toRow(r, all[i - 1]));

  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2>Machine {m.nickname} {!m.active && <Pill>Retired</Pill>}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="tabs">
        <button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Details</button>
        <button className={tab === 'assignments' ? 'active' : ''} onClick={() => setTab('assignments')}>Assignment history</button>
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>Usage history</button>
      </div>
      {error && <div className="error">{error}</div>}
      {tab === 'details' && (
        <>
          {m.active && (
            <div className="panel-box">
              <label className="field"><span>Campaign assignment</span>
                <SearchSelect value={campaign} options={options} onChange={setCampaign} placeholder="Unassigned" />
              </label>
              <label className="field"><span>Note</span><input value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional" /></label>
              <p className="muted small">Takes effect immediately for everything from now on.</p>
              <div className="form-actions">
                {m.campaign_id && <button type="button" className="btn" onClick={() => run(supabase.rpc('assign_machine', { p_machine: id, p_campaign: null, p_note: reason || null }))}>Unassign</button>}
                <div className="spacer" />
                <button type="button" className="btn primary" disabled={!campaign || campaign === m.campaign_id} onClick={() => run(supabase.rpc('assign_machine', { p_machine: id, p_campaign: campaign, p_note: reason || null }))}>Assign</button>
              </div>
            </div>
          )}
          <div className="fields">
            <label className="field"><span>Number</span><input type="number" min="1" step="1" disabled={!m.active} value={nickname} onChange={e => setNickname(e.target.value)} /></label>
            <label className="field"><span>Donary machine ID</span><input value={donaryId} onChange={e => setDonaryId(e.target.value)} /></label>
          </div>
          <label className="field"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
          <div className="form-actions">
            <button type="button" className={m.active ? 'btn danger' : 'btn'} onClick={() => {
              if (m.active && !confirm(`Retire machine ${m.nickname}? It leaves its campaign, and its number is never used again.`)) return;
              run(supabase.rpc('set_machine_active', { p_machine: id, p_active: !m.active }));
            }}>{m.active ? 'Retire machine' : 'Bring back into service'}</button>
            <div className="spacer" />
            <button type="button" className="btn primary" onClick={() => run(supabase.rpc('update_machine', { p_machine: id, p_nickname: Number(nickname), p_donary_id: donaryId, p_notes: notes || null }))}>Save details</button>
          </div>
        </>
      )}
      {tab === 'assignments' && (
        <div className="dialog-table">
          <DataTable
            title="Assignment history"
            rows={entries}
            loading={history.loading}
            exportName={`machine-${m.nickname}-assignments`}
            columns={[
              { key: 'to_campaign', label: 'Assigned to', value: r => r.to_campaign ?? 'Unassigned' },
              { key: 'from_campaign', label: 'Removed from', value: r => r.from_campaign ?? '' },
              { key: 'changed_at', label: 'From', render: r => dateTime(r.changed_at) },
              { key: 'until', label: 'Until', render: r => (r.until ? dateTime(r.until) : 'Now') },
              { key: 'changed_by', label: 'Changed by' },
              { key: 'note', label: 'Note' },
            ]}
          />
        </div>
      )}
      {tab === 'usage' && (
        <div className="dialog-table">
          <DataTable
            title="Usage history"
            rows={(usage.data as Row[]) ?? []}
            loading={usage.loading}
            exportName={`machine-${m.nickname}-usage`}
            columns={[
              { key: 'booking_date', label: 'Date' },
              { key: 'fundraiser', label: 'Fundraiser' },
              { key: 'campaign', label: 'Campaign', value: r => `${r.campaign_name ?? ''} - ${r.campaign_id}` },
              { key: 'status', label: 'Status', value: r => STATUS[r.status]?.label, render: r => <BookingPill status={r.status} /> },
              { key: 'admin_notes', label: 'Note' },
            ]}
          />
        </div>
      )}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Demand report
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Shabbos'];
const parts = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const shift = (iso: string, months: number) => { const d = parts(iso); d.setMonth(d.getMonth() + months); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const weekOf = (iso: string) => { const d = parts(iso); d.setDate(d.getDate() - d.getDay()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function Bars({ title, rows }: { title: string; rows: { name: string; total: number }[] }) {
  const max = Math.max(...rows.map(r => r.total), 1);
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="mini"><tbody>
        {rows.map(r => (
          <tr key={r.name}>
            <td>{r.name}<div className="bar"><span style={{ width: `${(r.total / max) * 100}%` }} /></div></td>
            <td className="right num">{r.total}</td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td className="muted">No requests in this period</td></tr>}
      </tbody></table>
    </div>
  );
}

export function MachineReportPage() {
  const [from, setFrom] = useState(shift(localToday(), -12));
  const [to, setTo] = useState(shift(localToday(), 3));
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('month');
  const q = useQuery(async () => {
    const [list, machines] = await Promise.all([
      fetchAll((a, b) => supabase.from('machine_booking_list').select('booking_date, status').gte('booking_date', from).lte('booking_date', to).order('booking_date').range(a, b) as never),
      supabase.from('machines').select('id', { count: 'exact', head: true }).eq('active', true),
    ]);
    return { list: list as Row[], machines: machines.count ?? 0 };
  }, [from, to]);
  const report = useMemo(() => {
    const list = q.data?.list ?? [];
    const machines = q.data?.machines ?? 0;
    const byDay = new Map<string, number>();
    for (const r of list) byDay.set(r.booking_date, (byDay.get(r.booking_date) ?? 0) + 1);
    // Demand, so a request that was later cancelled still counts.
    const days = [...byDay.entries()].map(([date, requests]) => ({ id: date, date, requests, over: requests > machines }));
    const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
    const weekday = new Map(WEEKDAYS.map(w => [w, 0]));
    const month = new Map<string, number>();
    const grouped = new Map<string, number>();
    for (const d of days) {
      add(weekday, WEEKDAYS[parts(d.date).getDay()], d.requests);
      add(month, d.date.slice(0, 7), d.requests);
      add(grouped, period === 'day' ? d.date : period === 'week' ? weekOf(d.date) : d.date.slice(0, 7), d.requests);
    }
    const toBars = (m: Map<string, number>) => [...m.entries()].map(([name, total]) => ({ name, total }));
    return {
      machines,
      total: list.length,
      average: days.length ? list.length / days.length : 0,
      days,
      over: days.filter(d => d.over),
      peak: [...days].sort((a, b) => b.requests - a.requests).slice(0, 5),
      weekday: toBars(weekday),
      month: toBars(month),
      grouped: [...grouped.entries()].map(([name, requests]) => ({ id: name, name, requests })),
    };
  }, [q.data, period]);

  return (
    <section className="view">
      <div className="filter-bar">
        <input type="date" aria-label="From" value={from} onChange={e => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={e => setTo(e.target.value)} />
      </div>
      <div className="kpis">
        <div className="kpi"><div><div className="kpi-label">Requests</div><div className="kpi-value">{report.total}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Average per requested day</div><div className="kpi-value">{report.average.toFixed(1)}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Over-capacity days</div><div className="kpi-value">{report.over.length}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Machines in service</div><div className="kpi-value">{report.machines}</div></div></div>
      </div>
      <div className="cards">
        <Bars title="By day of week" rows={report.weekday} />
        <Bars title="By month" rows={report.month} />
        <Bars title="Peak days" rows={report.peak.map(d => ({ name: d.date, total: d.requests }))} />
      </div>
      <DataTable
        title="Requests over time"
        rows={report.grouped}
        loading={q.loading}
        error={q.error}
        exportName={`machine-demand-by-${period}`}
        columns={[{ key: 'name', label: period === 'day' ? 'Day' : period === 'week' ? 'Week starting' : 'Month' }, { key: 'requests', label: 'Requests', align: 'right' }]}
        actions={
          <select aria-label="Group by" value={period} onChange={e => setPeriod(e.target.value as 'day' | 'week' | 'month')}>
            <option value="day">Per day</option><option value="week">Per week</option><option value="month">Per month</option>
          </select>
        }
      />
      <DataTable
        title="Over-capacity days"
        subtitle={<>More requests, including cancelled ones, than the {report.machines} machines in service now. See them on the <Link to="/calendar">calendar</Link>.</>}
        rows={report.over}
        loading={q.loading}
        exportName="machine-over-capacity-days"
        columns={[{ key: 'date', label: 'Day' }, { key: 'requests', label: 'Requests', align: 'right' }]}
      />
    </section>
  );
}
