import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight, Building2, CircleDollarSign, ClipboardCheck, Contact, HandCoins, Landmark, Layers, LogOut, Menu,
  PlusCircle, Receipt, RefreshCw, Repeat, Search, ShieldCheck, UserCircle, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

const SearchContext = createContext<{ q: string; setQ: (v: string) => void }>({ q: '', setQ: () => {} });
export const useSearch = () => useContext(SearchContext);

interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean }
interface NavSection { title: string; items: NavItem[] }

const I = 18;
const NAV: NavSection[] = [
  {
    title: 'Campaigns',
    items: [
      { to: '/campaigns/active', label: 'Active Campaigns', icon: <Landmark size={I} /> },
      { to: '/campaigns/all', label: 'All Campaigns', icon: <Layers size={I} /> },
      { to: '/campaigns/exchange', label: 'Exchange', icon: <Repeat size={I} />, admin: true },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true },
      { to: '/donations/recent', label: 'Last 7 Days', icon: <HandCoins size={I} /> },
      { to: '/donations/all', label: 'All Donations', icon: <CircleDollarSign size={I} /> },
      { to: '/expenses', label: 'Expenses', icon: <Receipt size={I} /> },
      { to: '/transfers', label: 'Transfers', icon: <ArrowLeftRight size={I} /> },
    ],
  },
  {
    title: 'People',
    items: [
      { to: '/donors', label: 'Donors', icon: <Contact size={I} /> },
      { to: '/tasks', label: 'Tasks', icon: <ClipboardCheck size={I} /> },
      { to: '/managers', label: 'Managers', icon: <UserCircle size={I} />, admin: true },
      { to: '/collectors', label: 'Collectors', icon: <Users size={I} />, admin: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      { to: '/sources', label: 'Sources', icon: <Wallet size={I} />, admin: true },
      { to: '/accounts', label: 'Accounts', icon: <Building2 size={I} />, admin: true },
      { to: '/users', label: 'Users & Access', icon: <ShieldCheck size={I} />, admin: true },
    ],
  },
];

export default function Layout() {
  const { isAdmin, profile, signOut } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const loc = useLocation();

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
            <div className="logo">O</div>
            <div className="logo-text">Oizer<small>Campaign CRM</small></div>
          </div>
          {NAV.map(section => {
            const items = section.items.filter(n => !n.admin || isAdmin);
            if (!items.length) return null;
            return (
              <div key={section.title}>
                <div className="nav-section">{section.title}</div>
                {items.map(n => (
                  <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {n.icon}<span>{n.label}</span>
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
                <div className="me-role">{profile?.role}</div>
              </div>
              <button className="icon-btn" title="Sign out" onClick={signOut}><LogOut size={17} /></button>
            </div>
          </div>
        </nav>
        {open && <div className="scrim" onClick={() => setOpen(false)} />}

        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(o => !o)} aria-label="Menu"><Menu size={20} /></button>
          <div className="crumb">{current?.section ?? 'Oizer'} / <b>{current?.label ?? 'Details'}</b></div>
          <label className="search">
            <Search size={16} />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${current?.label.toLowerCase() ?? ''}…`} />
            <span className="kbd">Ctrl K</span>
          </label>
          <button className="icon-btn outlined" title="Refresh data" onClick={() => setTick(t => t + 1)}><RefreshCw size={16} /></button>
        </header>

        <main className="content">
          <Outlet key={tick} />
        </main>
      </div>
    </SearchContext.Provider>
  );
}
