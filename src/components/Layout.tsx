import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive, ArrowLeftRight, ChevronDown, Banknote, BookOpen, BookUser, Building, Building2, CalendarDays, ChartColumn, CircleDollarSign, ClipboardCheck, Contact, CreditCard, FileCheck, FileText, Globe, FilePlus, HandCoins, Handshake, History, Landmark, Layers, LayoutDashboard, LayoutTemplate, ListChecks, ListPlus, Lock, LogOut, Menu, Percent, PieChart, Printer,
  Bell, Mail, MessageSquare, MessagesSquare, PlusCircle, Receipt, RefreshCw, Repeat, Scale, Send, Smartphone, Ticket, Search, ShieldCheck, Upload, UserCircle, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTaskCount } from '../pages/TaskSheet';
import { useUnreadMessages } from '../pages/Inbox';
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
      { to: '/inbox', label: 'Messages', icon: <MessagesSquare size={I} /> },
      { to: '/task-sheet', label: 'Task Sheet', icon: <ListChecks size={I} />, admin: true },
      { to: '/tasks', label: 'Tasks', icon: <ClipboardCheck size={I} /> },
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
      { to: '/requests', label: 'Campaign Requests', icon: <FilePlus size={I} /> },
      { to: '/machines', label: 'Machine Bookings', icon: <CreditCard size={I} /> },
      { to: '/campaigns/exchange', label: 'Exchange', icon: <Repeat size={I} />, admin: true },
    ],
  },
  {
    title: 'Donations',
    items: [
      { to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true },
      { to: '/donations/batch', label: 'Batch Entry', icon: <ListPlus size={I} />, admin: true },
      { to: '/donations/recent', label: 'Last 7 Days', icon: <HandCoins size={I} /> },
      { to: '/donations/all', label: 'All Transactions', icon: <CircleDollarSign size={I} /> },
      { to: '/recurring', label: 'Recurring', icon: <Repeat size={I} /> },
      { to: '/pledges', label: 'Pledges', icon: <Handshake size={I} /> },
      { to: '/vouchers', label: 'Vouchers', icon: <Ticket size={I} />, admin: true },
      { to: '/receipts', label: 'Receipts', icon: <FileCheck size={I} />, admin: true },
    ],
  },
  {
    title: 'Payouts',
    items: [
      { to: '/expenses', label: 'Payouts', icon: <Receipt size={I} /> },
      { to: '/payout-requests', label: 'Payout Requests', icon: <Send size={I} /> },
      { to: '/checks', label: 'Check Register', icon: <Printer size={I} />, admin: true },
      { to: '/transfers', label: 'Transfers', icon: <ArrowLeftRight size={I} />, admin: true },
    ],
  },
  {
    title: 'People',
    items: [
      { to: '/donors', label: 'Donors', icon: <Contact size={I} /> },
      { to: '/managers', label: 'Fundraisers', icon: <UserCircle size={I} />, admin: true },
      { to: '/fundraiser-directory', label: 'Fundraiser Directory', icon: <BookOpen size={I} />, admin: true },
      { to: '/collectors', label: 'Collectors', icon: <Users size={I} />, admin: true },
      { to: '/payees', label: 'Payees', icon: <BookUser size={I} /> },
    ],
  },
  {
    title: 'Outreach',
    items: [
      { to: '/outreach', label: 'New Message', icon: <Send size={I} />, admin: true },
      { to: '/outreach/history', label: 'Outreach History', icon: <History size={I} />, admin: true },
      { to: '/outreach/templates', label: 'Outreach Templates', icon: <FileText size={I} />, admin: true },
      { to: '/messages', label: 'Sent Messages', icon: <Mail size={I} />, admin: true },
    ],
  },
  {
    title: 'Reports',
    items: [
      { to: '/source-report', label: 'Source Report', icon: <PieChart size={I} /> },
      { to: '/balance-summary', label: 'Balance Summary', icon: <Scale size={I} />, admin: true },
      { to: '/machine-report', label: 'Booking Reports', icon: <ChartColumn size={I} />, admin: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      { to: '/organization', label: 'Organization', icon: <Building size={I} />, admin: true },
      { to: '/users', label: 'Users & Access', icon: <ShieldCheck size={I} />, admin: true },
      { to: '/accounts', label: 'Accounts', icon: <Building2 size={I} />, admin: true },
      { to: '/payments-settings', label: 'Payments', icon: <CreditCard size={I} />, admin: true },
      { to: '/fees', label: 'Methods & Fees', icon: <Percent size={I} />, admin: true },
      { to: '/payout-methods', label: 'Payout Methods', icon: <Banknote size={I} />, admin: true },
      { to: '/receipt-text', label: 'Receipt Text', icon: <FileText size={I} />, admin: true },
      { to: '/messaging-settings', label: 'Messaging', icon: <MessageSquare size={I} />, admin: true },
      { to: '/sources', label: 'Sources', icon: <Wallet size={I} />, admin: true },
      { to: '/templates', label: 'Campaign Templates', icon: <LayoutTemplate size={I} />, admin: true },
      { to: '/machine-registry', label: 'Donary Machines', icon: <Smartphone size={I} />, admin: true },
      { to: '/data-import', label: 'Data Import', icon: <Upload size={I} />, admin: true },
      { to: '/activity', label: 'Activity Log', icon: <History size={I} />, admin: true },
    ],
  },
  {
    title: 'Platform',
    items: [
      { to: '/platform', label: 'Organizations', icon: <Globe size={I} />, platform: true },
    ],
  },
];
// Pages reached from elsewhere (the sidebar footer), named here for the top bar.
const OTHER: NavItem[] = [{ to: '/notifications', label: 'My Notifications', icon: null }];

// Which sections are folded away, kept per browser. The section holding the open page always shows.
const FOLD_KEY = 'nav-folded';
const DEFAULT_FOLDED = ['Reports', 'Settings'];
function readFolded(): string[] {
  try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? 'null'); return Array.isArray(v) ? v : DEFAULT_FOLDED; } catch { return DEFAULT_FOLDED; }
}
function saveFolded(v: string[]) { try { localStorage.setItem(FOLD_KEY, JSON.stringify(v)); } catch { /* private window */ } }
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
  const unread = useUnreadMessages(canWork);

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

  const [folded, setFolded] = useState<string[]>(readFolded);
  const toggle = (title: string) => setFolded(f => { const v = f.includes(title) ? f.filter(t => t !== title) : [...f, title]; saveFolded(v); return v; });

  const all = [...NAV.flatMap(s => s.items.map(i => ({ ...i, section: s.title }))), ...OTHER.map(i => ({ ...i, section: 'Settings' }))];
  // The longest matching path wins, so /outreach/history isn't taken for /outreach.
  const current = all.filter(n => loc.pathname === n.to || loc.pathname.startsWith(`${n.to}/`)).sort((a, b) => b.to.length - a.to.length)[0]
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
            const here = current?.section === section.title;
            const shut = folded.includes(section.title) && !here;
            const count = items.reduce((t, n) => t + (n.to === '/task-sheet' ? taskCount : n.to === '/inbox' ? unread : 0), 0);
            return (
              <div key={section.title} className="nav-group">
                <button type="button" className="nav-section" aria-expanded={!shut} onClick={() => toggle(section.title)}
                  title={here ? 'The open page is in this section' : undefined}>
                  <span>{section.title}</span>
                  {shut && count > 0 && <span className="nav-count">{count}</span>}
                  <ChevronDown size={14} className={`nav-chev ${shut ? 'shut' : ''}`} />
                </button>
                {!shut && items.map(n => (
                  <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {n.icon}<span>{n.label}</span>
                    {n.to === '/task-sheet' && taskCount > 0 && <span className="nav-count">{taskCount}</span>}
                    {n.to === '/inbox' && unread > 0 && <span className="nav-count">{unread}</span>}
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
              {canWork && <NavLink className="icon-btn" title="My notifications" aria-label="My notifications" to="/notifications"><Bell size={17} /></NavLink>}
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
          {canWork && (
            <button className="icon-btn outlined bell" title={`${unread} unread message${unread === 1 ? '' : 's'}${isAdmin ? `, ${taskCount} on the Task Sheet` : ''}`}
              onClick={() => nav(isAdmin && !unread && taskCount ? '/task-sheet' : '/inbox')}>
              <Bell size={16} />{unread + (isAdmin ? taskCount : 0) > 0 && <span className="nav-count">{unread + (isAdmin ? taskCount : 0)}</span>}
            </button>
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
