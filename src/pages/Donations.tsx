import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import DataTable, { sumBadge } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import { useSearch } from '../components/Layout';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { donationFields } from '../lib/schemas';
import { DONATION_SELECT, donationColumns } from './donationColumns';

function useDonationEditor(onChange: (row: Row) => void) {
  const { isAdmin } = useAuth();
  const [editing, setEditing] = useState<Row | null>(null);
  const editor = editing && (
    <RecordForm
      table="donations"
      title="Edit Donation"
      fields={donationFields}
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

export function RecentDonations() {
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const { data, error, loading, setData } = useQuery(() => {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    return fetchAll((a, b) =>
      supabase.from('donations').select(DONATION_SELECT).gte('created_at', since).order('created_at', { ascending: false }).range(a, b),
    );
  });
  const { open, editor } = useDonationEditor(row => setData(d => replaceRow(d, row)));

  return (
    <>
      <DataTable
        title="Donation last 7 days"
        rows={data ?? []}
        loading={loading}
        error={error}
        columns={donationColumns()}
        groupBy={{ value: r => r.type, badge: sumBadge('amount') }}
        onOpen={open ?? undefined}
        actions={isAdmin && <button className="btn primary" onClick={() => nav('/donations/new')}><Plus size={18} /> Add</button>}
      />
      {editor}
    </>
  );
}

const PAGE = 500;

export function AllDonations() {
  const { q } = useSearch();
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(0);
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [debounced, setDebounced] = useState(q);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const { data, error, loading, setData } = useQuery(async () => {
    let query = supabase.from('donations').select(DONATION_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
    if (type) query = query.eq('type', type);
    if (from) query = query.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
    if (to) query = query.lt('created_at', new Date(new Date(`${to}T00:00:00`).getTime() + 864e5).toISOString());
    const s = debounced.trim().replace(/[,()*]/g, ' ');
    if (s) {
      const like = `%${s}%`;
      query = query.or(
        [`name.ilike.${like}`, `donor_label.ilike.${like}`, `notes.ilike.${like}`, `payment_method.ilike.${like}`,
         `phone.ilike.${like}`, `batch_id.ilike.${like}`, `campaign_id.eq.${s}`].join(','),
      );
    }
    const { data, count, error } = await query.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    return { rows: data ?? [], count: count ?? 0 };
  }, [debounced, page, type, from, to]);

  const { open, editor } = useDonationEditor(row => setData(d => d && { ...d, rows: replaceRow(d.rows, row) }));
  const pages = Math.ceil((data?.count ?? 0) / PAGE);

  return (
    <>
      <DataTable
        title="All Donations"
        rows={data?.rows ?? []}
        loading={loading}
        error={error}
        columns={donationColumns()}
        serverSearch
        onOpen={open ?? undefined}
        actions={
          <>
            <select value={type} onChange={e => { setType(e.target.value); setPage(0); }}>
              <option value="">All types</option>
              {['Payment', 'Batch', 'Collect', 'Voided'].map(t => <option key={t}>{t}</option>)}
            </select>
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(0); }} title="From" />
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(0); }} title="To" />
            {isAdmin && <button className="btn primary" onClick={() => nav('/donations/new')}><Plus size={18} /> Add</button>}
          </>
        }
        footer={
          <div className="pager">
            <button className="btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span>Page {page + 1} of {Math.max(pages, 1)} · {(data?.count ?? 0).toLocaleString()} donations</span>
            <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        }
      />
      {editor}
    </>
  );
}

export function NewDonation() {
  const nav = useNavigate();
  const [last, setLast] = useState<Row | null>(null);
  const [key, setKey] = useState(0);
  return (
    <section className="view narrow">
      <div className="view-head"><h1>New Donation</h1></div>
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
        fields={donationFields}
        defaults={{ type: 'Payment', source: 'Manual', account_id: '8d4b5fbe', created_at: new Date().toISOString() }}
        onClose={() => nav(-1)}
        onSaved={row => { setLast(row); setKey(k => k + 1); }}
      />
    </section>
  );
}
