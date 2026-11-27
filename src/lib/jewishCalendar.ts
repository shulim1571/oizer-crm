import { HDate, HebrewCalendar, Location, TimedEvent, flags, type Event } from '@hebcal/core';

// Worked out here rather than fetched, so it needs no yearly update and never goes down.
// Eastern Time and the diaspora calendar, as the spec says.
const NEW_YORK = new Location(40.7128, -74.006, false, 'America/New_York', 'New York');

export interface JewishDay {
  iso: string;
  day: number;
  hebrew: string;
  hebrewEnglish: string;
  shabbos: boolean;
  yomTov: boolean;
  cholHamoed: boolean;
  parsha: string | null;
  holidays: string[];
  candles: string | null;
  havdalah: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const clock = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
};
const nameOf = (e: Event) =>
  e.render('ashkenazi').replace(/^Chanukah/, 'Chanuka').replace(/\(CH[’']+M\)/, '(Chol HaMoed)').replace(/ Candles?$/, m => m.toLowerCase());

const blank = (date: Date): JewishDay => {
  const h = new HDate(date);
  return {
    iso: isoOf(date),
    day: date.getDate(),
    hebrew: h.renderGematriya(true).split(' ').slice(0, -1).join(' '),
    hebrewEnglish: h.render('ashkenazi'),
    shabbos: date.getDay() === 6,
    yomTov: false,
    cholHamoed: false,
    parsha: null,
    holidays: [],
    candles: null,
    havdalah: null,
  };
};

/** Every day from start to end, both included. */
export function jewishDays(start: Date, end: Date): JewishDay[] {
  const days = new Map<string, JewishDay>();
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.set(isoOf(d), blank(d));
  const events = HebrewCalendar.calendar({
    start, end, il: false, location: NEW_YORK, candlelighting: true, sedrot: true,
    noModern: true, noRoshChodesh: true, noSpecialShabbat: true,
  });
  for (const e of events) {
    const day = days.get(isoOf(e.getDate().greg()));
    if (!day) continue;
    const f = e.getFlags();
    const desc = e.getDesc();
    if (desc === 'Candle lighting') { day.candles = clock((e as TimedEvent).eventTimeStr); continue; }
    if (desc === 'Havdalah') { day.havdalah = clock((e as TimedEvent).eventTimeStr); continue; }
    if (f & flags.PARSHA_HASHAVUA) { day.parsha = nameOf(e); continue; }
    // Fast start and end times and the chametz times aren't needed for planning.
    if (e instanceof TimedEvent && !(f & flags.CHANUKAH_CANDLES)) continue;
    if (desc === 'Chag HaBanot') continue;
    if (f & flags.CHAG) day.yomTov = true;
    if (f & flags.CHOL_HAMOED) day.cholHamoed = true;
    day.holidays.push(nameOf(e));
  }
  return [...days.values()];
}

/** Why a date needs a second look, or null when it's an ordinary day. */
export function dateWarning(iso: string): string | null {
  const date = dateOf(iso);
  if (Number.isNaN(date.getTime())) return null;
  const [day] = jewishDays(date, date);
  if (day.yomTov) return `${day.holidays[0]} is Yom Tov${day.shabbos ? ' and Shabbos' : ''}`;
  if (day.shabbos) return `This is Shabbos${day.parsha ? `, ${day.parsha}` : ''}`;
  return null;
}
