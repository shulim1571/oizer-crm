import { useSearchParams } from 'react-router-dom';

// Tabs inside one page. The open tab is in the address (?tab=…), so it can be linked and survives a refresh;
// the page's own address doesn't change.

export function usePageTab<T extends string>(tabs: readonly T[]): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as T | null;
  const tab = raw && tabs.includes(raw) ? raw : tabs[0];
  const set = (t: T) => setParams(t === tabs[0] ? {} : { tab: t }, { replace: true });
  return [tab, set];
}

export default function PageTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [T, string])[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}
