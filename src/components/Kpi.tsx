import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: 'violet' | 'green' | 'red' | 'amber' | 'blue';
  sub?: ReactNode;
  small?: boolean;
}

export default function Kpi({ label, value, icon, tone = 'violet', sub, small }: Props) {
  return (
    <div className="kpi">
      <div className={`kpi-icon ${tone}`}>{icon}</div>
      <div>
        <div className="kpi-label">{label}</div>
        <div className={`kpi-value ${small ? 'small' : ''}`}>{value}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}
