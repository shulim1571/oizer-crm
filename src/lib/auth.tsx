import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { logActivity, supabase, type Row } from './supabase';
import { applyOrg, leavePlatformOrg, platformOrg, resolveOrg, type Org } from './org';

type Role = 'admin' | 'manager' | 'pending';

interface Access {
  org_id: string | null;
  role: Role | null;
  is_platform_owner: boolean;
  in_platform_session: boolean;
  orgs: { id: string; slug: string; name: string; role: Role }[];
}

interface AuthState {
  session: Session | null;
  profile: Row | null;
  org: Org | null;
  role: Role | null;
  isAdmin: boolean;
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

  async function loadAccess(s: Session | null) {
    if (!s) {
      setProfile(null);
      setAccess(null);
      return;
    }
    const [{ data: p }, { data: a }] = await Promise.all([
      supabase.from('profiles').select('*').eq('user_id', s.user.id).maybeSingle(),
      supabase.rpc('my_access'),
    ]);
    const next = a as Access | null;
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
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
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
    isAdmin: role === 'admin',
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
