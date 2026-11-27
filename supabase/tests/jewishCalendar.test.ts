import { describe, expect, it } from 'vitest';
import { dateOf, dateWarning, jewishDays } from '../../src/lib/jewishCalendar';

const day = (iso: string) => jewishDays(dateOf(iso), dateOf(iso))[0];

describe('Jewish calendar', () => {
  it('knows the Jewish date', () => {
    expect(day('2026-11-01').hebrewEnglish).toContain('Cheshvan');
    expect(day('2026-11-01').hebrew).toBe('כ״א חשון');
  });

  it('marks Shabbos with its parsha and times', () => {
    const shabbos = day('2026-10-31');
    expect(shabbos).toMatchObject({ shabbos: true, yomTov: false, parsha: 'Parshas Vayera', havdalah: '6:35 pm' });
    expect(day('2026-10-30').candles).toBe('5:36 pm');
  });

  it('marks Yom Tov, with two days in the diaspora, and Chol HaMoed', () => {
    expect(day('2027-04-22')).toMatchObject({ yomTov: true, holidays: ['Pesach I'] });
    expect(day('2027-04-23')).toMatchObject({ yomTov: true, holidays: ['Pesach II'] });
    expect(day('2027-04-25')).toMatchObject({ yomTov: false, cholHamoed: true });
    expect(day('2026-09-21').yomTov).toBe(true);
    expect(day('2026-10-03').holidays).toContain('Shmini Atzeres');
    expect(day('2026-10-04').holidays).toContain('Simchas Torah');
  });

  it('shows Chanuka and Purim without treating them as Yom Tov', () => {
    expect(day('2026-12-06').holidays[0]).toMatch(/^Chanuka/);
    expect(day('2027-03-23')).toMatchObject({ yomTov: false, holidays: ['Purim'] });
  });

  it('warns on Shabbos and Yom Tov only', () => {
    expect(dateWarning('2026-10-31')).toBe('This is Shabbos, Parshas Vayera');
    expect(dateWarning('2027-04-22')).toBe('Pesach I is Yom Tov');
    expect(dateWarning('2026-09-12')).toMatch(/Yom Tov and Shabbos/);
    expect(dateWarning('2026-11-02')).toBeNull();
    expect(dateWarning('2027-04-25')).toBeNull();
    expect(dateWarning('2027-03-23')).toBeNull();
    expect(dateWarning('not a date')).toBeNull();
  });
});
