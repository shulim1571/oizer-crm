import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** Link to an admin-only page; plain text for everyone else. Clicks don't open the row underneath. */
export default function AdminLink({ to, children }: { to: string; children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <>{children}</>;
  return <Link to={to} onClick={e => e.stopPropagation()}>{children}</Link>;
}
