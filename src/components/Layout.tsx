import { HelpAssistant } from '../pages/Assistant';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, Bell, BookUser, Building, CalendarDays, ChevronDown, CircleDollarSign, Contact, Globe, Landmark, LayoutDashboard, LayoutTemplate, ListChecks, Lock, LogOut, Menu, MessageSquare, MessagesSquare, PieChart, PlusCircle, Receipt, RefreshCw, Scale, Search, Send, ShieldCheck, Smartphone, Upload, UserCircle, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTaskCount } from '../pages/TaskSheet';
import { noteActivity } from '../lib/idle';
import { useUnreadMessages } from '../pages/Inbox';
import { supabase } from '../lib/supabase';
import { leavePlatformOrg, type Org } from '../lib/org';
import { PoweredBy } from './PoweredBy';
import PageErrorBoundary from './PageErrorBoundary';
import { sharpLogoUrl } from '../lib/sharpLogo';

/** The product: Donor Base (Shulim, 2026-11-12). Oizer and other organizations are customers inside it. */
export const PRODUCT_NAME = 'Donor Base';
export const PRODUCT_TILE = `${import.meta.env.BASE_URL}brand/donor-base-tile.png`;
export const PRODUCT_MARK = `${import.meta.env.BASE_URL}brand/donor-base-mark.png`;
export const PRODUCT_MARK_WHITE = `${import.meta.env.BASE_URL}brand/donor-base-mark-white.png`;

/** The Donor Base logo: its tile on light backgrounds; just the white mark on a colored one (the sign-in panel). */
export function ProductLogo({ onColor = false }: { onColor?: boolean }) {
  return <img className={`logo product-logo${onColor ? ' on-color' : ''}`} src={onColor ? PRODUCT_MARK_WHITE : PRODUCT_TILE} alt={PRODUCT_NAME} />;
}

/** The organization's own logo where it has one (sharp, at any size); otherwise the Donor Base logo. */
export function OrgLogo({ org, onColor = false }: { org: Org | null; onColor?: boolean }) {
  return org?.logo_url
    ? <img className="logo org-logo" src={sharpLogoUrl(org.logo_url)!} alt={org.name ? `${org.name} logo` : ''} />
    : <ProductLogo onColor={onColor} />;
}

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', manager: 'Fundraiser', guest: 'Community Guest', pending: 'Pending',
};

const SearchContext = createContext<{ q: string; setQ: (v: string) => void }>({ q: '', setQ: () => {} });
export const useSearch = () => useContext(SearchContext);

interface Tab { to: string; label: string; admin?: boolean }
// offMenu: not listed in the sidebar, but its pages still get their tabs and breadcrumb.
interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean; platform?: boolean; offMenu?: boolean; tabs?: Tab[]; badge?: 'tasks' | 'inbox' }
interface NavSection { title: string; items: NavItem[] }

// One entry per kind of work. Views of the same list (active/archived campaigns, last 7 days/all transactions…)
// are tabs above the page instead of separate entries; every page keeps its own address.
const I = 18;
const NAV: NavSection[] = [
  {
    title: 'Home',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={I} /> },
      { to: '/task-sheet', label: 'Tasks', icon: <ListChecks size={I} />, badge: 'tasks',
        tabs: [{ to: '/task-sheet', label: 'Task Sheet', admin: true }, { to: '/tasks', label: 'Campaign Tasks' }] },
      { to: '/inbox', label: 'Messages', icon: <MessagesSquare size={I} />, badge: 'inbox' },
      { to: '/outreach', label: 'Outreach', icon: <Send size={I} />, admin: true,
        tabs: [{ to: '/outreach', label: 'New Message' }, { to: '/outreach/history', label: 'History' },
          { to: '/outreach/templates', label: 'Templates' }, { to: '/outreach/links', label: 'Fundraiser Links' }, { to: '/messages', label: 'Sent Messages' }] },
      { to: '/source-report', label: 'Reports', icon: <PieChart size={I} />,
        tabs: [{ to: '/source-report', label: 'Sources' }, { to: '/sources', label: 'Source list', admin: true }, { to: '/balance-summary', label: 'Balances', admin: true },
          { to: '/machine-report', label: 'Bookings', admin: true }] },
    ],
  },
  {
    // Campaigns and People in one menu, named "Campaigns & People", in this order (Moshe Henig, 2026-11-11):
    // Campaigns, Fundraisers, Donors, Payees, Machine Bookings.
    title: 'Campaigns & People',
    items: [
      { to: '/campaigns/active', label: 'Campaigns', icon: <Landmark size={I} />,
        tabs: [{ to: '/campaigns/active', label: 'Active' }, { to: '/campaigns/all', label: 'All' }, { to: '/campaigns/archived', label: 'Archived' },
          { to: '/campaigns/closed', label: 'Closed' },
          { to: '/campaigns/requests', label: 'Requests' }] },
      { to: '/managers', label: 'Fundraisers', icon: <UserCircle size={I} />, admin: true,
        tabs: [{ to: '/managers', label: 'Fundraisers' }, { to: '/fundraiser-directory', label: 'Directory' }] },
      { to: '/donors', label: 'Donors', icon: <Contact size={I} /> },
      { to: '/payees', label: 'Payees', icon: <BookUser size={I} /> },
      // Everyone opens the calendar, where bookings show on their day; fundraisers see only their own (Moshe Henig, 2026-11-11).
      { to: '/machines', label: 'Machine Bookings', icon: <CalendarDays size={I} />,
        tabs: [{ to: '/calendar', label: 'Calendar' }, { to: '/machines', label: 'Bookings' }] },
    ],
  },
  {
    // Transactions joined Payouts, Transfers and Bank Reconciliation in one group named Transactions; the Donations
    // group went away (New Donation is off the menu, in the header bar) (Moshe Henig, 2026-11-11).
    title: 'Transactions',
    items: [
      // One list with a date range (Last 7 days, 30, 60, a year or custom) instead of a Last 7 Days tab; Recurring,
      // Pledges, Vouchers and Receipts are tabs here, like Requests under Campaigns (Moshe Henig, 2026-11-11).
      { to: '/donations/all', label: 'Transactions', icon: <CircleDollarSign size={I} />,
        tabs: [{ to: '/donations/all', label: 'Transactions' }, { to: '/donations/recurring', label: 'Recurring' },
          { to: '/donations/pledges', label: 'Pledges' }, { to: '/donations/vouchers', label: 'Vouchers', admin: true },
          { to: '/donations/receipts', label: 'Receipts', admin: true }] },
      // Opened from the New Donation button in the header bar, so it's off the sidebar (Moshe Henig, 2026-11-11).
      { to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true, offMenu: true,
        // Batch Entry gave way to new pledges and vouchers (Moshe Henig, 2026-11-11); it stays on a campaign's page.
        tabs: [{ to: '/donations/new', label: 'One donation' }, { to: '/donations/pledges/new', label: 'New pledge' },
          { to: '/donations/vouchers/new', label: 'New vouchers' }] },
      { to: '/expenses', label: 'Payouts', icon: <Receipt size={I} />,
        // Check Register is a tab between Payouts and Requests, admins only (Moshe Henig, 2026-11-11).
        tabs: [{ to: '/expenses', label: 'Payouts' }, { to: '/checks', label: 'Check Register', admin: true }, { to: '/payout-requests', label: 'Requests' }] },
      { to: '/transfers', label: 'Transfers', icon: <ArrowLeftRight size={I} />, admin: true },
      { to: '/reconciliation', label: 'Bank Reconciliation', icon: <Scale size={I} />, admin: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      // Your own settings, for everyone; they were small buttons next to Log out (Moshe Henig, 2026-11-11).
      { to: '/notifications', label: 'My Notifications', icon: <Bell size={I} /> },
      { to: '/security', label: 'Account Security', icon: <Lock size={I} /> },
      { to: '/organization', label: 'Organization', icon: <Building size={I} />, admin: true,
        tabs: [{ to: '/organization', label: 'Details' }, { to: '/web-addresses', label: 'Web Addresses' }, { to: '/api-keys', label: 'API Keys' }] },
      { to: '/users', label: 'Users & Access', icon: <ShieldCheck size={I} />, admin: true,
        tabs: [{ to: '/users', label: 'Users' }, { to: '/activity', label: 'Activity Log' }] },
      { to: '/payments-settings', label: 'Payments', icon: <Wallet size={I} />, admin: true,
        tabs: [{ to: '/payments-settings', label: 'Card Processing' }, { to: '/fees', label: 'Methods & Fees' },
          { to: '/payout-methods', label: 'Payout Methods' }, { to: '/accounts', label: 'Bank Accounts' }] },
      { to: '/messaging-settings', label: 'Messaging', icon: <MessageSquare size={I} />, admin: true,
        tabs: [{ to: '/messaging-settings', label: 'Email & Text' }, { to: '/phone-lookup', label: 'Phone & Text Lookup' }, { to: '/receipt-text', label: 'Receipt Text' }] },
      { to: '/machine-registry', label: 'Machines & Donary', icon: <Smartphone size={I} />, admin: true,
        tabs: [{ to: '/machine-registry', label: 'Donary Machines' }, { to: '/donary', label: 'Donary Connection' }] },
      { to: '/templates', label: 'Campaign Templates', icon: <LayoutTemplate size={I} />, admin: true },
      { to: '/data-import', label: 'Data Import', icon: <Upload size={I} />, admin: true },
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
const OTHER: NavItem[] = [];

const onPath = (path: string, to: string) => path === to || path.startsWith(`${to}/`);

// Which sections are folded away, kept per browser. The section holding the open page always shows.
const FOLD_KEY = 'nav-folded';
const DEFAULT_FOLDED = ['Settings'];
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
    noteActivity();   // moving between pages counts as activity for the idle sign-out
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

  const allowed = (t: { admin?: boolean }) => !t.admin || isAdmin;
  const visible = (n: NavItem) => (n.platform ? isPlatformOwner : canWork && (!n.admin || isAdmin));
  // An entry's tabs this person may open; the entry opens the first of them.
  const tabsOf = (n: NavItem) => (n.tabs ?? []).filter(allowed);
  const entryTo = (n: NavItem) => tabsOf(n)[0]?.to ?? n.to;
  const paths = (n: NavItem) => (n.tabs ? tabsOf(n).map(t => t.to) : [n.to]);
  const all = [...NAV.flatMap(s => s.items.filter(visible).map(i => ({ ...i, section: s.title }))), ...OTHER.map(i => ({ ...i, section: 'Settings' }))];
  // The longest matching path wins, so /outreach/history is the History tab, not New Message.
  const matches = all.flatMap(n => paths(n).filter(p => onPath(loc.pathname, p)).map(p => ({ n, p })))
    .sort((a, b) => b.p.length - a.p.length)[0];
  const tab = matches?.n.tabs?.find(t => t.to === matches.p);
  const current = matches ? { section: matches.n.section, label: tab && tab.label !== matches.n.label ? `${matches.n.label} · ${tab.label}` : matches.n.label, item: matches.n }
    : loc.pathname.startsWith('/campaigns/') ? { section: 'Campaigns & People', label: 'Campaign', item: undefined }
      : loc.pathname.startsWith('/donors/') ? { section: 'Campaigns & People', label: 'Donor', item: undefined } : undefined;
  const pageTabs = current?.item ? tabsOf(current.item) : [];
  const badge = (n: NavItem) => (n.badge === 'tasks' && isAdmin ? taskCount : n.badge === 'inbox' ? unread : 0);
  const email = profile?.email ?? '';

  return (
    <SearchContext.Provider value={{ q, setQ }}>
      <div className="app">
        <nav className={`sidebar ${open ? 'open' : ''}`}>
          <div className="logo-row">
            <OrgLogo org={org} />
            <div className="logo-text">{org?.name ?? PRODUCT_NAME}{org && <small>{PRODUCT_NAME}</small>}</div>
          </div>
          {NAV.map(section => {
            const items = section.items.filter(n => visible(n) && !n.offMenu);
            if (!items.length) return null;
            const here = current?.section === section.title;
            const shut = folded.includes(section.title) && !here;
            const count = items.reduce((t, n) => t + badge(n), 0);
            return (
              <div key={section.title} className="nav-group">
                <button type="button" className="nav-section" aria-expanded={!shut} onClick={() => toggle(section.title)}
                  title={here ? 'The open page is in this section' : undefined}>
                  <span>{section.title}</span>
                  {shut && count > 0 && <span className="nav-count">{count}</span>}
                  <ChevronDown size={14} className={`nav-chev ${shut ? 'shut' : ''}`} />
                </button>
                {!shut && items.map(n => (
                  <NavLink key={n.label} to={entryTo(n)} className={() => (current?.item?.label === n.label ? 'active' : '')}>
                    {n.icon}<span>{n.label}</span>
                    {badge(n) > 0 && <span className="nav-count">{badge(n)}</span>}
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
          {/* New Donation on every page, just before the bell (Moshe Henig, 2026-11-11); it's an admin page. */}
          {/* Fundraisers too (Moshe Henig, 2026-11-12): theirs takes card payments, and manual ones with the permission. */}
          {canWork && <button className="btn primary small header-new-donation" onClick={() => nav('/donations/new')}><PlusCircle size={15} /> New Donation</button>}
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
          {pageTabs.length > 1 && (
            <nav className="tabs page-tabs" aria-label={current?.item?.label}>
              {pageTabs.map(t => <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? 'active' : '')}>{t.label}</NavLink>)}
            </nav>
          )}
          <PageErrorBoundary resetKey={loc.pathname + tick}><Outlet key={tick} /></PageErrorBoundary>
          <PoweredBy orgId={org?.id} />
        </main>
        <HelpAssistant />
      </div>
    </SearchContext.Provider>
  );
}
