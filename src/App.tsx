import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './lib/auth';
import { supabase } from './lib/supabase';
import Login, { AuthShell, ConfirmEmailLink, SetNewPassword, readEmailLink } from './pages/Login';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import { AllDonations, NewDonation, RecentDonations } from './pages/Donations';
import { DonorDetail, DonorsPage } from './pages/Donors';
import UsersPage from './pages/Users';
import ActivityPage from './pages/Activity';
import OrganizationPage from './pages/Organization';
import PlatformPage from './pages/Platform';
import GuestPage from './pages/Guest';
import BatchEntry from './pages/BatchEntry';
import FeesPage from './pages/Fees';
import { PledgesPage } from './pages/Pledges';
import { VouchersPage } from './pages/Vouchers';
import { AccountDetail, ManagerDetail, SourceDetail } from './pages/Related';
import {
  AccountsPage, CollectorsPage, ExpensesPage, ManagersPage, SourcesPage, TasksPage, TransfersPage,
} from './pages/SimplePages';

// Read once at startup: reading it clears an error from the address bar.
const arrivedWith = readEmailLink();

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? <>{children}</> : <Navigate to="/campaigns/active" replace />;
}

export default function App() {
  const { session, role, memberStatus, org, orgs, isPlatformOwner, loading, signOut, refresh } = useAuth();
  const [recovering, setRecovering] = useState(false);
  const [emailLink, setEmailLink] = useState(arrivedWith);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (loading) return <div className="splash"><div className="logo">O</div></div>;
  if (emailLink.tokenHash && emailLink.type) {
    return (
      <ConfirmEmailLink tokenHash={emailLink.tokenHash} type={emailLink.type} onDone={() => {
        if (emailLink.type === 'recovery') setRecovering(true);
        setEmailLink({ tokenHash: null, type: null, error: null });
      }} />
    );
  }
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Login linkError={emailLink.error} />;
  if (role === 'guest') {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<GuestPage />} />
        </Route>
      </Routes>
    );
  }
  if (!role || role === 'pending') {
    if (isPlatformOwner) {
      return (
        <Routes>
          <Route element={<Layout />}>
            <Route path="platform" element={<PlatformPage />} />
            <Route path="*" element={<Navigate to="/platform" replace />} />
          </Route>
        </Routes>
      );
    }
    return (
      <AuthShell>
        <div className="auth-card">
          <h1>{memberStatus === 'suspended' || memberStatus === 'deactivated' ? 'Access paused' : 'Waiting for access'}</h1>
          <p className="lead">
            You're signed in as <b>{session.user.email}</b>, but {memberStatus === 'suspended' ? 'this account is suspended'
              : memberStatus === 'deactivated' ? 'this account has been deactivated'
              : role ? 'an admin hasn\'t given this login access yet'
              : org ? `this login isn't part of ${org.name}` : 'this web address doesn\'t lead to one of your organizations'}.
          </p>
          {orgs.length > 0 && (
            <div className="auth-links">
              {orgs.map(o => <a key={o.id} className="btn" href={`?org=${encodeURIComponent(o.slug)}`}>Go to {o.name}</a>)}
            </div>
          )}
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
        <Route path="campaigns/archived" element={<Campaigns mode="archived" />} />
        <Route path="campaigns/closed" element={<Campaigns mode="closed" />} />
        <Route path="campaigns/exchange" element={<AdminOnly><Campaigns mode="exchange" /></AdminOnly>} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="campaigns/:id/batch" element={<BatchEntry />} />
        <Route path="donations/batch" element={<AdminOnly><BatchEntry /></AdminOnly>} />
        <Route path="fees" element={<AdminOnly><FeesPage /></AdminOnly>} />
        <Route path="donations/new" element={<AdminOnly><NewDonation /></AdminOnly>} />
        <Route path="donations/recent" element={<RecentDonations />} />
        <Route path="donations/all" element={<AllDonations />} />
        <Route path="pledges" element={<PledgesPage />} />
        <Route path="vouchers" element={<AdminOnly><VouchersPage /></AdminOnly>} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route path="sources" element={<AdminOnly><SourcesPage /></AdminOnly>} />
        <Route path="sources/:id" element={<AdminOnly><SourceDetail /></AdminOnly>} />
        <Route path="accounts" element={<AdminOnly><AccountsPage /></AdminOnly>} />
        <Route path="accounts/:id" element={<AdminOnly><AccountDetail /></AdminOnly>} />
        <Route path="managers" element={<AdminOnly><ManagersPage /></AdminOnly>} />
        <Route path="managers/:id" element={<AdminOnly><ManagerDetail /></AdminOnly>} />
        <Route path="collectors" element={<AdminOnly><CollectorsPage /></AdminOnly>} />
        <Route path="donors" element={<DonorsPage />} />
        <Route path="donors/:id" element={<DonorDetail />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="activity" element={<AdminOnly><ActivityPage /></AdminOnly>} />
        <Route path="organization" element={<AdminOnly><OrganizationPage /></AdminOnly>} />
        {isPlatformOwner && <Route path="platform" element={<PlatformPage />} />}
        <Route path="*" element={<Navigate to="/campaigns/active" replace />} />
      </Route>
    </Routes>
  );
}
