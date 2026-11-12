import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CreditCard, Plus } from 'lucide-react';
import DataTable, { exactValue, parseNumberFilter, type Column, type ServerQuery } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import Pager from '../components/Pager';
import { useSearch } from '../components/Layout';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { editDonationFields, fundraiserDonationFields, newDonationFields } from '../lib/schemas';
import { campaignOptions, type Option } from '../lib/lookups';
import TransactionBulk from './TransactionBulk';
import { DONATION_KINDS, DONATION_SELECT, donationColumns } from './donationColumns';
import { CardChargeDialog } from './Payments';

function useDonationEditor(onChange: (row: Row) => void) {
  const { isAdmin } = useAuth();
  const [editing, setEditing] = useState<Row | null>(null);
  const editor = editing && (
    <RecordForm
      table="donations"
      title="Edit Donation"
      fields={editDonationFields}
      record={editing}
      allowDelete
      onClose={() => setEditing(null)}
      onSaved={async row => {
        setEditing(null);
        if (row._deleted) return onChange(row);
        const { data } = await supabase.from('donations').select(DONATION_SELECT).eq('id', row.id).single();
        onChange(data ?? row);
      }}
    />
  );
  return { open: isAdmin ? setEditing : undefined, editor };
}

const replaceRow = (list: Row[] | null, row: Row) =>
  row._deleted ? (list ?? []).filter(r => r.id !== row.id) : (list ?? []).map(r => (r.id === row.id ? row : r));

/** Successful (completed) only, until someone picks another type. */
export const DEFAULT_KIND = 'Successful';
const UNATTRIBUTED = 'Unattributed';
const DUPLICATES = 'Possible duplicates';

export function AllDonations() {
  return <PagedDonations title="All Transactions" />;
}

/** Applies the column filters typed into the table to a query on transaction_list. */
function applyColumnFilters<Q extends { ilike: Function; gte: Function; gt: Function; lte: Function; lt: Function; eq: Function; or: Function }>(
  query: Q, columns: Column[], filters: Record<string, string>,
): Q {
  let q = query;
  for (const c of columns) {
    const text = filters[c.key]?.trim();
    if (!text) continue;
    const exact = exactValue(text);
    if (c.key === 'type') {
      const wanted = (exact ?? text).toLowerCase();
      const kind = exact != null
        ? Object.entries(DONATION_KINDS).find(([k]) => k.toLowerCase() === wanted)?.[1]
        : Object.entries(DONATION_KINDS).find(([k]) => k.toLowerCase().startsWith(wanted))?.[1];
      if (kind) q = q.eq('status', kind.status);
      if (kind?.type) q = q.eq('type', kind.type);
      continue;
    }
    if (!c.filter) continue;
    const col = c.filter.column;
    if (c.filter.type === 'number') {
      const b = parseNumberFilter(text);
      if (!b) continue;
      if (b.min != null) q = b.minOpen ? q.gt(col, b.min) : q.gte(col, b.min);
      if (b.max != null) q = b.maxOpen ? q.lt(col, b.max) : q.lte(col, b.max);
    } else if (c.filter.type === 'date') {
      // A whole day, month or year: 2026-11-01, 2026-11 or 2026.
      const m = text.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
      if (!m) continue;
      const [y, mo, day] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null];
      const from = new Date(y, (mo ?? 1) - 1, day ?? 1);
      const to = day ? new Date(y, mo! - 1, day + 1) : mo ? new Date(y, mo, 1) : new Date(y + 1, 0, 1);
      q = q.gte(col, from.toISOString()).lt(col, to.toISOString());
    } else if (exact != null) {
      // Picked from the dropdown: that value exactly (case aside), not "contains".
      q = q.ilike(col, exact.replace(/[%_\\]/g, m => `\\${m}`));
    } else {
      q = q.ilike(col, `%${text.replace(/[%_]/g, '')}%`);
    }
  }
  return q;
}

/** Server-paged, searchable transaction list; `filter` limits it to one source, account, etc. */
export function PagedDonations({ title, filter }: { title: string; filter?: { column: string; value: string } }) {
  const { q } = useSearch();
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(0);
  const [kindFilter, setKindFilter] = useState(DEFAULT_KIND);
  const [debounced, setDebounced] = useState(q);
  const [query, setQuery] = useState<ServerQuery | null>(null);
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  // A donation just recorded on New Donation lands here with a note saying so (Moshe Henig, 2026-11-11).
  const arrived = (useLocation().state as { notice?: string } | null)?.notice ?? null;
  const [notice, setNotice] = useState<string | null>(arrived);
  const [version, setVersion] = useState(0);
  const columns = useMemo(() => donationColumns(), []);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  // The same conditions for rows, totals and "select all", so they can never disagree.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions = (base: any) => {
    let s = base;
    if (filter) s = s.eq(filter.column, filter.value);
    const kind = DONATION_KINDS[kindFilter];
    if (kind) s = s.eq('status', kind.status);
    if (kind?.type) s = s.eq('type', kind.type);
    if (kindFilter === UNATTRIBUTED) s = s.is('campaign_id', null);
    const text = debounced.trim().replace(/[,()*]/g, ' ');
    // The date range picked above the list (replaces the Last 7 Days tab). Searching looks through every date
    // (Moshe Henig, 2026-11-11), so the range is set aside while there is search text.
    if (!text && query?.range.from) s = s.gte('created_at', query.range.from);
    if (!text && query?.range.to) s = s.lt('created_at', query.range.to);
    if (kindFilter === DUPLICATES) s = s.eq('possible_duplicate', true);
    if (text) {
      const like = `%${text}%`;
      s = s.or(
        [`name.ilike.${like}`, `donor_name.ilike.${like}`, `notes.ilike.${like}`, `payment_method.ilike.${like}`,
         `phone.ilike.${like}`, `batch_id.ilike.${like}`, `check_number.ilike.${like}`, `id.eq.${text}`, `campaign_id.eq.${text}`, `voucher_id.eq.${text}`].join(','),
      );
    }
    return applyColumnFilters(s, columns, query?.filters ?? {});
  };

  const queryKey = JSON.stringify([debounced, kindFilter, query, filter?.column, filter?.value, version]);
  useEffect(() => setPage(0), [queryKey]);
  useEffect(() => setSelected(new Map()), [queryKey]);

  const { data, error, loading, setData } = useQuery(async () => {
    if (!query) return { rows: [], count: 0 };
    const sortColumn = query.sort && columns.find(c => c.key === query.sort!.key)?.filter?.column;
    const size = query.pageSize;
    const { data, count, error } = await conditions(supabase.from('transaction_list').select(DONATION_SELECT, { count: 'exact' }))
      .order(sortColumn || 'created_at', { ascending: sortColumn ? query.sort!.dir === 'asc' : false })
      .range(page * size, page * size + size - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as Row[], count: count ?? (data ?? []).length };
  }, [queryKey, page]);

  // Voided, refunded and failed transactions don't count, unless that's what's being looked at.
  const totals = useQuery(async () => {
    if (!query) return null;
    // Counted over the same transactions the sums cover, so the average is right whatever type is picked.
    let t = conditions(supabase.from('transaction_list').select('gross:amount.sum(),net:net_donation.sum(),fees:fee.sum(),counted:id.count()'));
    if (!DONATION_KINDS[kindFilter] && !query.filters.type?.trim()) t = t.in('status', ['completed', 'collect']);
    const { data, error } = await t;
    if (error) throw new Error(error.message);
    return (data as Row[])?.[0] ?? null;
  }, [queryKey]);

  const searching = !!debounced.trim();

  const { open, editor } = useDonationEditor(row => {
    if (row._deleted) return setVersion(v => v + 1);
    setData(d => d && { ...d, rows: replaceRow(d.rows, row) });
    totals.reload();
  });
  const pages = query ? Math.ceil((data?.count ?? 0) / query.pageSize) : 0;

  const matching = () => fetchAll((a, b) => conditions(supabase.from('transaction_list').select(DONATION_SELECT))
    .order('created_at', { ascending: false }).range(a, b));

  async function selectAll() {
    const all = await fetchAll((a, b) => conditions(supabase.from('transaction_list').select('id, amount')).order('id').range(a, b));
    setSelected(new Map(all.map(r => [String(r.id), Number(r.amount)])));
  }

  const onSelect = (rows: Row[], on: boolean) => setSelected(prev => {
    const next = new Map(prev);
    for (const r of rows) {
      if (on) next.set(String(r.id), Number(r.amount));
      else next.delete(String(r.id));
    }
    return next;
  });
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);

  return (
    <>
      <DataTable
        title={title}
        viewKey={filter ? 'Transactions (filtered)' : 'All Transactions'}
        exportName={filter ? `${title}-${filter.value}` : title}
        subtitle={`${(data?.count ?? 0).toLocaleString()} transaction${data?.count === 1 ? "" : "s"}`}
        rows={data?.rows ?? []}
        loading={loading}
        error={error ?? totals.error}
        columns={columns}
        serverSearch
        onServerQuery={setQuery}
        exportAll={matching}
        onOpen={open ?? undefined}
        selected={isAdmin ? selectedIds : undefined}
        onSelect={isAdmin ? onSelect : undefined}
        dateRange={{ column: 'created_at', defaultPreset: filter ? 'all' : '7' }}
        summary={
          <>
            {/* The summary totals what's shown right now: date range, type, filters and search (Moshe Henig, 2026-11-11). */}
            <div className="totals-bar" aria-label="Totals for this view">
              <span className="muted small"><b>This view</b>{searching ? ' (all dates, search)' : ''}</span>
              <span>Gross <b>{money(totals.data?.gross ?? 0)}</b></span>
              <span>Fees <b>{money(totals.data?.fees ?? 0)}</b></span>
              <span>Net <b>{money(totals.data?.net ?? 0)}</b></span>
              <span>{Number(totals.data?.counted ?? 0).toLocaleString()} transaction{Number(totals.data?.counted) === 1 ? '' : 's'}{Number(totals.data?.counted) ? <> · avg <b>{money(Number(totals.data?.gross ?? 0) / Number(totals.data?.counted))}</b></> : null}</span>
              {!kindFilter && !query?.filters.type?.trim() && <span className="muted small">Leaves out voided, refunded and failed transactions ({(data?.count ?? 0).toLocaleString()} listed in all).</span>}
            </div>
            {searching && <p className="muted small">Searching all dates: the date range is set aside while you search.</p>}
            {notice && <div className="notice">{notice}</div>}
            {isAdmin && (
              <TransactionBulk
                selected={selected}
                matching={data?.count ?? 0}
                onClear={() => setSelected(new Map())}
                onSelectAll={selectAll}
                onDone={message => { setNotice(message); setVersion(v => v + 1); }}
              />
            )}
          </>
        }
        more={[{ label: 'Batch entry', onClick: () => nav('/donations/batch'), hidden: !isAdmin || !!filter }]}
        actions={
          <>
            <select value={kindFilter} onChange={e => setKindFilter(e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {Object.keys(DONATION_KINDS).map(t => <option key={t}>{t}</option>)}
              <option>{UNATTRIBUTED}</option>
              <option>{DUPLICATES}</option>
            </select>
            {isAdmin && !filter && <button className="btn primary" onClick={() => nav('/donations/new')}><Plus size={16} /> New donation</button>}
          </>
        }
        footer={
          <>
            <span>Page {page + 1} of {Math.max(pages, 1)}</span>
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        }
      />
      {editor}
    </>
  );
}

/**
 * New Donation for fundraisers (Moshe Henig, 2026-11-12): a card payment to one of their own campaigns. With the
 * "enter manual payments" permission they can also enter a manual payment for the campaigns it covers, held until an
 * admin approves, the same as on the campaign page.
 */
export function FundraiserNewDonation() {
  const nav = useNavigate();
  const [charging, setCharging] = useState(false);
  const [last, setLast] = useState<Row | null>(null);
  const [manual, setManual] = useState<Option[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    void (async () => {
      const mine = new Set(((await supabase.rpc('my_campaign_ids')).data ?? []) as string[]);
      const options = (await campaignOptions()).filter(o => mine.has(String(o.value)));
      const allowed = await Promise.all(options.map(async o =>
        !!(await supabase.rpc('has_override', { p_permission: 'enter_manual_payments', p_campaign: o.value })).data));
      setManual(options.filter((_, i) => allowed[i]));
    })();
  }, []);
  return (
    <section className="view narrow">
      <div className="view-head">
        <div className="view-title"><h1>New Donation</h1><span className="count">Take a payment for one of your campaigns</span></div>
      </div>
      <div className="panel-box">
        <h2>Card payment</h2>
        <p className="muted small">Charge the donor's card now. It goes straight onto the campaign once the card is approved.</p>
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn primary" onClick={() => setCharging(true)}><CreditCard size={15} /> Charge a card</button></div>
      </div>
      {charging && <CardChargeDialog fundraiser onClose={() => setCharging(false)} onDone={t => setLast({ amount: t.amount, campaign_id: t.campaign_id })} />}
      {last && (
        <div className="notice">
          Charged {money(last.amount)} to campaign {last.campaign_id}.{' '}
          <button className="link" onClick={() => nav(`/campaigns/${encodeURIComponent(last.campaign_id)}`)}>Open campaign</button>
        </div>
      )}
      {saved && <div className="notice">{saved}</div>}
      {manual && manual.length > 0 && (
        <RecordForm
          key={formKey}
          inline
          table="donations"
          title="Manual payment (held for approval)"
          description="Cash, check, Zelle and the like. It's held until the office approves it."
          saveLabel="Enter payment"
          fields={[{ name: 'campaign_id', label: 'Campaign', type: 'select', options: manual, required: true }, ...fundraiserDonationFields]}
          defaults={{ source: 'Manual' }}
          onClose={() => nav(-1)}
          onSaved={row => { setSaved(`Entered ${money(row.amount)} for campaign ${row.campaign_id}, held until the office approves it.`); setFormKey(k => k + 1); }}
        />
      )}
    </section>
  );
}

export function NewDonation() {
  const nav = useNavigate();
  const [last, setLast] = useState<Row | null>(null);
  const [key] = useState(0);
  const [charging, setCharging] = useState(false);
  return (
    <section className="view narrow">
      <div className="view-head">
        <div className="view-title"><h1>New Donation</h1><span className="count">Record a gift against a campaign</span></div>
        <div className="view-actions"><button type="button" className="btn" onClick={() => setCharging(true)}><CreditCard size={15} /> Charge a card</button></div>
      </div>
      <p className="muted small">Record a gift you already have (cash, check, Zelle…) below. To take a card payment now, use <b>Charge a card</b>.</p>
      {charging && <CardChargeDialog onClose={() => setCharging(false)} onDone={t => setLast({ amount: t.amount, campaign_id: t.campaign_id })} />}
      {last && (
        <div className="notice">
          Saved {money(last.amount)} to campaign {last.campaign_id}.{' '}
          <button className="link" onClick={() => nav(`/campaigns/${encodeURIComponent(last.campaign_id)}`)}>Open campaign</button>
        </div>
      )}
      <RecordForm
        key={key}
        inline
        table="donations"
        title="Donation details"
        saveLabel="Record donation"
        fields={newDonationFields}
        defaults={{ type: 'Payment', status: 'completed', source: 'Manual', created_at: new Date().toISOString() }}
        onClose={() => nav(-1)}
        // Recorded: go to the Transactions list, which says what was saved (Moshe Henig, 2026-11-11).
        onSaved={row => nav('/donations/all', { state: { notice: `Recorded ${money(row.amount)} to campaign ${row.campaign_id}${row.id ? ` (transaction ${row.id})` : ''}.` } })}
      />
    </section>
  );
}
