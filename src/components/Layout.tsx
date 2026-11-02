import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive, ArrowLeftRight, Banknote, BookUser, Building, Building2, CalendarDays, ChartColumn, CircleDollarSign, ClipboardCheck, Contact, CreditCard, Globe, FilePlus, HandCoins, Handshake, History, Landmark, Layers, LayoutDashboard, LayoutTemplate, ListChecks, ListPlus, Lock, LogOut, Menu, Percent,
  PlusCircle, Receipt, RefreshCw, Repeat, Scale, Send, Smartphone, Ticket, Search, ShieldCheck, UserCircle, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTaskCount } from '../pages/TaskSheet';
import { supabase } from '../lib/supabase';
import { leavePlatformOrg, type Org } from '../lib/org';

export function OrgLogo({ org }: { org: Org | null }) {
  return org?.logo_url
    ? <img className="logo" src={org.logo_url} alt="" />
    : <div className="logo">{(org?.name?.[0] ?? 'C').toUpperCase()}</div>;
}

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', manager: 'Fundraiser', guest: 'Community Guest', pending: 'Pending',
};

const SearchContext = createContext<{ q: string; setQ: (v: string) => void }>({ q: '', setQ: () => {} });
export const useSearch = () => useContext(SearchContext);

interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean; platform?: boolean }
interface NavSection { title: string; items: NavItem[] }

const I = 18;
const NAV: NavSection[] = [
  {
    title: 'Home',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={I} /> },
      { to: '/calendar', label: 'Jewish Calendar', icon: <CalendarDays size={I} />, admin: true },
    ],
  },
  {
    title: 'Campaigns',
    items: [
      { to: '/campaigns/active', label: 'Active Campaigns', icon: <Landmark size={I} /> },
      { to: '/campaigns/all', label: 'All Campaigns', icon: <Layers size={I} /> },
      { to: '/campaigns/archived', label: 'Archived', icon: <Archive size={I} /> },
      { to: '/campaigns/closed', label: 'Closed', icon: <Lock size={I} /> },
      { to: '/campaigns/exchange', label: 'Exchange', icon: <Repeat size={I} />, admin: true },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true },
      { to: '/donations/batch', label: 'Batch Entry', icon: <ListPlus size={I} />, admin: true },
      { to: '/donations/recent', label: 'Last 7 Days', icon: <HandCoins size={I} /> },
      { to: '/donations/all', label: 'All Transactions', icon: <CircleDollarSign size={I} /> },
      { to: '/vouchers', label: 'Vouchers', icon: <Ticket size={I} />, admin: true },
      { to: '/pledges', label: 'Pledges', icon: <Handshake size={I} /> },
      { to: '/expenses', label: 'Payouts', icon: <Receipt size={I} /> },
      { to: '/payout-requests', label: 'Payout Requests', icon: <Send size={I} /> },
      { to: '/transfers', label: 'Transfers', icon: <ArrowLeftRight size={I} />, admin: true },
    ],
  },
  {
    title: 'Machines',
    items: [
      { to: '/machines', label: 'Machine Bookings', icon: <CreditCard size={I} /> },
      { to: '/machine-report', label: 'Booking Reports', icon: <ChartColumn size={I} />, admin: true },
    ],
  },
  {
    title: 'People',
    items: [
      { to: '/donors', label: 'Donors', icon: <Contact size={I} /> },
      { to: '/payees', label: 'Payees', icon: <BookUser size={I} /> },
      { to: '/task-sheet', label: 'Task Sheet', icon: <ListChecks size={I} />, admin: true },
      { to: '/requests', label: 'Campaign Requests', icon: <FilePlus size={I} /> },
      { to: '/tasks', label: 'Tasks', icon: <ClipboardCheck size={I} /> },
      { to: '/managers', label: 'Fundraisers', icon: <UserCircle size={I} />, admin: true },
      { to: '/balance-summary', label: 'Balance Summary', icon: <Scale size={I} />, admin: true },
      { to: '/collectors', label: 'Collectors', icon: <Users size={I} />, admin: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      { to: '/machine-registry', label: 'Donary Machines', icon: <Smartphone size={I} />, admin: true },
      { to: '/sources', label: 'Sources', icon: <Wallet size={I} />, admin: true },
      { to: '/templates', label: 'Campaign Templates', icon: <LayoutTemplate size={I} />, admin: true },
      { to: '/fees', label: 'Methods & Fees', icon: <Percent size={I} />, admin: true },
      { to: '/payout-methods', label: 'Payout Methods', icon: <Banknote size={I} />, admin: true },
      { to: '/accounts', label: 'Accounts', icon: <Building2 size={I} />, admin: true },
      { to: '/users', label: 'Users & Access', icon: <ShieldCheck size={I} />, admin: true },
      { to: '/activity', label: 'Activity Log', icon: <History size={I} />, admin: true },
      { to: '/organization', label: 'Organization', icon: <Building size={I} />, admin: true },
    ],
  },
  {
    title: 'Platform',
    items: [
      { to: '/platform', label: 'Organizations', icon: <Globe size={I} />, platform: true },
    ],
  },
];

export default function Layout() {
  const { isAdmin, canWork, isPlatformOwner, inPlatformSession, org, role, profile, signOut } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [campaignId, setCampaignId] = useState('');
  const nav = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const loc = useLocation();
  // Counted again on every page change, so it follows what's just been dealt with.
  const taskCount = useTaskCount(isAdmin, loc.pathname + loc.key);

  useEffect(() => {
    setQ('');
    setOpen(false);
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const all = NAV.flatMap(s => s.items.map(i => ({ ...i, section: s.title })));
  const current = all.find(n => loc.pathname.startsWith(n.to))
    ?? (loc.pathname.startsWith('/campaigns/') ? { section: 'Campaigns', label: 'Campaign' }
      : loc.pathname.startsWith('/donors/') ? { section: 'People', label: 'Donor' } : undefined);
  const email = profile?.email ?? '';

  return (
    <SearchContext.Provider value={{ q, setQ }}>
      <div className="app">
        <nav className={`sidebar ${open ? 'open' : ''}`}>
          <div className="logo-row">
            <OrgLogo org={org} />
            <div className="logo-text">{org?.name ?? 'Campaign CRM'}{org && <small>Campaign CRM</small>}</div>
          </div>
          {NAV.map(section => {
            const items = section.items.filter(n => (n.platform ? isPlatformOwner : canWork && (!n.admin || isAdmin)));
            if (!items.length) return null;
            return (
              <div key={section.title}>
                <div className="nav-section">{section.title}</div>
                {items.map(n => (
                  <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {n.icon}<span>{n.label}</span>
                    {n.to === '/task-sheet' && taskCount > 0 && <span className="nav-count">{taskCount}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
          <div className="sidebar-foot">
            <div className="me">
              <span className="avatar">{(email[0] ?? '?').toUpperCase()}</span>
              <div className="me-text">
                <div className="me-email" title={email}>{email}</div>
                <div className="me-role">{inPlatformSession ? 'Platform Owner' : ROLE_LABEL[role ?? ''] ?? (isPlatformOwner ? 'Platform Owner' : '')}</div>
              </div>
              <button className="icon-btn" title="Sign out" onClick={signOut}><LogOut size={17} /></button>
            </div>
          </div>
        </nav>
        {open && <div className="scrim" onClick={() => setOpen(false)} />}

        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(o => !o)} aria-label="Menu"><Menu size={20} /></button>
          <div className="crumb">{current?.section ?? org?.name ?? 'CRM'} / <b>{current?.label ?? 'Details'}</b></div>
          <label className="search">
            <Search size={16} />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${current?.label.toLowerCase() ?? ''}…`} />
            <span className="kbd">Ctrl K</span>
          </label>
          {canWork && (
            <form onSubmit={e => {
              e.preventDefault();
              if (campaignId.trim()) nav(`/campaigns/${encodeURIComponent(campaignId.trim())}`);
              setCampaignId('');
            }}>
              <input className="id-jump" aria-label="Go to campaign ID" placeholder="Campaign ID" value={campaignId} onChange={e => setCampaignId(e.target.value)} />
            </form>
          )}
          <button className="icon-btn outlined" title="Refresh data" onClick={() => setTick(t => t + 1)}><RefreshCw size={16} /></button>
        </header>

        <main className="content">
          {inPlatformSession && (
            <div className="notice session-banner">
              <span>You're inside <b>{org?.name}</b> as Platform Owner. Everything you do here appears in their activity log.</span>
              <button className="btn" onClick={async () => { await supabase.rpc('platform_exit_org'); leavePlatformOrg(); }}>Exit</button>
            </div>
          )}
          <Outlet key={tick} />
        </main>
      </div>
    </SearchContext.Provider>
  );
}
