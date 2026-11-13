import { describe, expect, it } from 'vitest';
import { parseStaleDays, STALE_CHECK_DEFAULT } from './staleCheck';

describe('stale-check threshold', () => {
  it('defaults to 90 days, as the Task Sheet does', () => expect(STALE_CHECK_DEFAULT).toBe(90));
  it('accepts whole days from 1 to 3650', () => {
    expect(parseStaleDays('90')).toBe(90);
    expect(parseStaleDays(' 1 ')).toBe(1);
    expect(parseStaleDays('3650')).toBe(3650);
  });
  it('rejects anything else with a message', () => {
    for (const bad of ['', '0', '3651', '-5', '30.5', 'abc', '1e3']) expect(typeof parseStaleDays(bad)).toBe('string');
  });
});
