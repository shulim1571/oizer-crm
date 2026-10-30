import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight, Building2, CircleDollarSign, ClipboardCheck, HandCoins, Landmark, LogOut, Menu,
  Plus, Receipt, RefreshCw, Repeat, Search, UserCircle, UserCog, Users, Wallet, Contact,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

const SearchContext = createContext<{ q: string; setQ: (v: string) => void }>({ q: '', setQ: () => {} });
export const useSearch = () => useContext(SearchContext);

const RefreshContext = createContext(0);
export const useRefreshTick = () => useContext(RefreshContext);

interface NavItem { to: string; label: string; icon: ReactNode; admin?: boolean }

const NAV: (NavItem | 'divider')[] = [
  { to: '/campaigns/active', label: 'Active Campaigns', icon: <Landmark size={20} /> },
  { to: '/campaigns/exchange', label: 'Exchange', icon: <Repeat size={20} />, admin: true },
  { to: '/donations/new', label: 'New Donation', icon: <Plus size={20} />, admin: true },
  { to: '/donations/recent', label: 'Donation last 7 days', icon: <HandCoins size={20} /> },
  { to: '/donations/all', label: 'All Donations', icon: <CircleDollarSign size={20} /> },
  { to: '/expenses', label: 'Expense', icon: <Receipt size={20} /> },
  { to: '/transfers', label: 'Transfer', icon: <ArrowLeftRight size={20} /> },
  { to: '/sources', label: 'Source', icon: <Wallet size={20} />, admin: true },
  { to: '/accounts', label: 'Account', icon: <Building2 size={20} />, admin: true },
  { to: '/managers', label: 'Manager', icon: <UserCircle size={20} />, admin: true },
  { to: '/collectors', label: 'Collector', icon: <Users size={20} />, admin: true },
  { to: '/donors', label: 'Donor', icon: <Contact size={20} /> },
  { to: '/tasks', label: 'Task', icon: <ClipboardCheck size={20} /> },
  { to: '/campaigns/all', label: 'All Campaigns', icon: <Landmark size={20} /> },
  'divider',
  { to: '/users', label: 'Users & Access', icon: <UserCog size={20} />, admin: true },
];

export default function Layout() {
  const { isAdmin, profile, signOut } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const loc = useLocation();

  useEffect(() => {
    setQ('');
    setOpen(false);
  }, [loc.pathname]);

  const current = NAV.find(n => n !== 'divider' && loc.pathname.startsWith(n.to)) as NavItem | undefined;

  return (
    <SearchContext.Provider value={{ q, setQ }}>
      <RefreshContext.Provider value={tick}>
        <div className="app">
          <header className="topbar">
            <button className="icon-btn" onClick={() => setOpen(o => !o)} aria-label="Menu"><Menu size={22} /></button>
            <div className="brand">Oizer</div>
            <label className="search">
              <Search size={18} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${current?.label ?? ''}`} />
            </label>
            <button className="icon-btn" title="Refresh data" onClick={() => setTick(t => t + 1)}><RefreshCw size={18} /></button>
            <div className="user-chip" title={profile?.email}>
              <span className="avatar">{(profile?.email ?? '?')[0].toUpperCase()}</span>
              <span className="role">{profile?.role}</span>
              <button className="icon-btn" title="Sign out" onClick={signOut}><LogOut size={18} /></button>
            </div>
          </header>
          <nav className={`sidebar ${open ? 'open' : ''}`}>
            {NAV.filter(n => n === 'divider' || !n.admin || isAdmin).map((n, i) =>
              n === 'divider' ? <hr key={i} /> : (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {n.icon}<span>{n.label}</span>
                </NavLink>
              ),
            )}
          </nav>
          {open && <div className="scrim" onClick={() => setOpen(false)} />}
          <main className="content">
            <Outlet key={tick} />
          </main>
        </div>
      </RefreshContext.Provider>
    </SearchContext.Provider>
  );
}
