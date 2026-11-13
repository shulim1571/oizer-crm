import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

// The organization's "Powered by" line: its own words and link, shown only when its Super Admin turns it on.

export interface Footer { enabled: boolean; text: string | null; url: string | null }

export async function loadFooter(orgId: string): Promise<Footer | null> {
  const { data } = await supabase.rpc('org_footer', { p_org: orgId });
  return ((data as Footer[] | null) ?? [])[0] ?? null;
}

export function useFooter(orgId: string | null | undefined) {
  const [footer, setFooter] = useState<Footer | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void loadFooter(orgId).then(f => { if (live) setFooter(f); });
    return () => { live = false; };
  }, [orgId]);
  return footer;
}

export function PoweredBy({ orgId, className = 'powered-by' }: { orgId: string | null | undefined; className?: string }) {
  const f = useFooter(orgId);
  if (!f?.enabled || !f.text) return null;
  return (
    <div className={className}>
      {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer">{f.text}</a> : f.text}
    </div>
  );
}

/** The setting, on the Organization page. */
export function FooterSettings() {
  const { org, isSuperAdmin } = useAuth();
  const [v, setV] = useState<Footer>({ enabled: false, text: '', url: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (org?.id) void loadFooter(org.id).then(f => f && setV({ enabled: f.enabled, text: f.text ?? '', url: f.url ?? '' }));
  }, [org?.id]);

  async function save() {
    setMsg(null);
    const { error } = await supabase.rpc('save_org_footer', { p_enabled: v.enabled, p_text: v.text, p_url: v.url });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: 'Saved.' });
  }

  return (
    <div className="panel-box">
      <h2>“Powered by” footer</h2>
      <p className="muted small">A short line at the bottom of your payment pages, sign-in page and portal.</p>
      {isSuperAdmin ? (
        <>
          <label className="check"><input type="checkbox" checked={v.enabled} onChange={e => setV({ ...v, enabled: e.target.checked })} /> Show the footer</label>
          <div className="fields">
            <label className="field"><span>Words</span>
              <input value={v.text ?? ''} maxLength={80} placeholder="Powered by …" onChange={e => setV({ ...v, text: e.target.value })} /></label>
            <label className="field"><span>Link (optional)</span>
              <input value={v.url ?? ''} placeholder="https://…" onChange={e => setV({ ...v, url: e.target.value })} /></label>
          </div>
          {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
          <div className="form-actions"><div className="spacer" /><button className="btn primary" onClick={save}>Save footer</button></div>
        </>
      ) : (
        <p className="muted small">{v.enabled ? `Showing: ${v.text}` : 'Not shown.'} Only the Super Admin can change it.</p>
      )}
    </div>
  );
}
