import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the Collectors feature is gone from every screen. Its tables and data stay in the database.
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : [];
});

describe('collectors', () => {
  it('appear nowhere in the app: no page, menu entry, form field, column, filter or lookup', () => {
    const offenders = files('src').filter(p => {
      const code = readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
      return /collectors|collector_id|CollectorsPage|collectorOptions|'Collector'/.test(code.replace(/path="collectors" element=\{<Navigate to="\/dashboard" replace \/>\}/, ''));
    });
    expect(offenders).toEqual([]);
  });

  it('send old links to the dashboard', () => {
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="collectors" element={<Navigate to="/dashboard" replace />} />');
  });
});
