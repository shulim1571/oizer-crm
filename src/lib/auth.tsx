import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { logActivity, supabase, type Row } from './supabase';
import { latestOnly, loadAccessSafely } from './accessLoad';
import { clearActivity, startFreshSession, watchIdle } from './idle';
import { applyOrg, leavePlatformOrg, platformOrg, resolveOrg, type Org } from './org';

type Role = 'super_admin' | 'admin' | 'manager' | 'guest' | 'pending';

interface Access {
  org_id: string | null;
  role: Role | null;
  status: string | null;
  permissions: string[];
  is_platform_owner: boolean;
  in_platform_session: boolean;
  orgs: { id: string; slug: string; name: string; role: Role }[];
}

interface AuthState {
  session: Session | null;
  profile: Row | null;
  org: Org | null;
  role: Role | null;
  /** Active, suspended or deactivated in this organization. */
  memberStatus: string | null;
  /** The access check itself failed (not the same as having no access). */
  accessError: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Admins and fundraisers: the people who use the portal, as opposed to guests. */
  canWork: boolean;
  /** Super-admin powers this login holds. */
  permissions: string[];
  isPlatformOwner: boolean;
  inPlatformSession: boolean;
  /** Organizations this login belongs to, for when the URL doesn't lead to one of them. */
  orgs: Access['orgs'];
  defaultAccountId: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Row | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [newest] = useState(latestOnly);

  async function loadAccess(s: Session | null) {
    const current = newest();
    if (!s) {
      setProfile(null);
      setAccess(null);
      setAccessError(null);
      return;
    }
    const [{ data: p }, result] = await Promise.all([
      supabase.from('profiles').select('*').eq('user_id', s.user.id).maybeSingle(),
      loadAccessSafely<Access>(() => supabase.rpc('my_access'), () => supabase.auth.refreshSession()),
    ]);
    if (!current()) return;   // a newer check has started; its answer wins
    if (result.kind === 'expired') {
      // The browser still remembers the login, but the session is no longer valid: sign in again.
      setAccessError(null);
      await supabase.auth.signOut({ scope: 'local' });
      return;
    }
    if (result.kind === 'error') {
      setAccessError(result.message);
      setProfile(p);
      return;
    }
    setAccessError(null);
    const next = result.access;
    // A Platform Owner's session expired or was closed elsewhere: back to their own view.
    if (platformOrg() && !next?.in_platform_session) return leavePlatformOrg();
    if (next?.org_id) {
      const [{ data: full }, { data: account }] = await Promise.all([
        supabase.from('organizations').select('*').eq('id', next.org_id).maybeSingle(),
        supabase.from('settings').select('value').eq('key', 'default_account_id').maybeSingle(),
      ]);
      if (full) {
        applyOrg(full as Org);
        setOrg(full as Org);
      }
      setDefaultAccountId((account?.value as string | undefined) ?? null);
    }
    setProfile(p);
    setAccess(next);
  }

  // Signed out after 30 minutes without activity (the server also limits idle time and total session length).
  useEffect(() => {
    if (!session) return;
    return watchIdle(() => {
      clearActivity();
      try { sessionStorage.setItem('signed-out-idle', '1'); } catch { /* ignore */ }
      void supabase.auth.signOut({ scope: 'local' });
    });
  }, [session]);

  useEffect(() => {
    // Nothing may ask about access until the requests carry the organization.
    const orgReady = resolveOrg().then(found => {
      applyOrg(found);
      setOrg(found);
    });
    orgReady.then(async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      await loadAccess(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // A fresh sign-in restarts the idle clock before anything checks it.
      if (event === 'SIGNED_IN') startFreshSession();
      setSession(s);
      // Defer so we don't call Supabase inside the auth callback.
      setTimeout(() => orgReady.then(() => loadAccess(s)), 0);
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const role = access?.role ?? null;
  const value: AuthState = {
    session,
    profile,
    org,
    role,
    memberStatus: access?.status ?? null,
    accessError,
    isAdmin: role === 'admin' || role === 'super_admin',
    isSuperAdmin: role === 'super_admin',
    canWork: role === 'admin' || role === 'super_admin' || role === 'manager',
    permissions: access?.permissions ?? [],
    isPlatformOwner: access?.is_platform_owner ?? false,
    inPlatformSession: access?.in_platform_session ?? false,
    orgs: access?.orgs ?? [],
    defaultAccountId,
    loading,
    refresh: () => loadAccess(session),
    signOut: async () => {
      await logActivity('logout');
      await supabase.auth.signOut();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
