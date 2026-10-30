import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './lib/auth';
import { supabase } from './lib/supabase';
import Login, { AuthShell, SetNewPassword } from './pages/Login';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import { AllDonations, NewDonation, RecentDonations } from './pages/Donations';
import { DonorDetail, DonorsPage } from './pages/Donors';
import UsersPage from './pages/Users';
import {
  AccountsPage, CollectorsPage, ExpensesPage, ManagersPage, SourcesPage, TasksPage, TransfersPage,
} from './pages/SimplePages';

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? <>{children}</> : <Navigate to="/campaigns/active" replace />;
}

export default function App() {
  const { session, profile, loading, signOut, refresh } = useAuth();
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (loading) return <div className="splash"><div className="logo">O</div></div>;
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Login />;
  if (!profile || profile.role === 'pending') {
    return (
      <AuthShell>
        <div className="auth-card">
          <h1>Waiting for access</h1>
          <p className="lead">You're signed in as <b>{session.user.email}</b>, but an admin hasn't given this login access yet.</p>
          <p className="muted">Ask the office to link your login to your campaigns, then refresh.</p>
          <div className="auth-links">
            <button className="btn" onClick={refresh}>Refresh</button>
            <button className="btn primary" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/campaigns/active" replace />} />
        <Route path="campaigns/active" element={<Campaigns mode="active" />} />
        <Route path="campaigns/all" element={<Campaigns mode="all" />} />
        <Route path="campaigns/exchange" element={<AdminOnly><Campaigns mode="exchange" /></AdminOnly>} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="donations/new" element={<AdminOnly><NewDonation /></AdminOnly>} />
        <Route path="donations/recent" element={<RecentDonations />} />
        <Route path="donations/all" element={<AllDonations />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route path="sources" element={<AdminOnly><SourcesPage /></AdminOnly>} />
        <Route path="accounts" element={<AdminOnly><AccountsPage /></AdminOnly>} />
        <Route path="managers" element={<AdminOnly><ManagersPage /></AdminOnly>} />
        <Route path="collectors" element={<AdminOnly><CollectorsPage /></AdminOnly>} />
        <Route path="donors" element={<DonorsPage />} />
        <Route path="donors/:id" element={<DonorDetail />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/campaigns/active" replace />} />
      </Route>
    </Routes>
  );
}
