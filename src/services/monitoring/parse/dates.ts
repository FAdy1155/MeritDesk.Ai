// Reads the date a source states ("October 9, 2026", "Oct 9, 2026",
// "10/09/2026", "2026/10/09", "2026-10-09T00:00:00-04:00", "Fri, 09 Oct 2026
// 16:01:25 GMT") into YYYY-MM-DD, taking the calendar date as written: no
// time zone conversion, so a feed's "Sat, 10 Oct 2026 15:04 -0500" stays
// October 10. The stated text itself is always stored alongside.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAME = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first date stated in `text`, as YYYY-MM-DD; null when none parses. */
export function parseStatedDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, " ");

  let m = /\b(\d{4})-(\d{2})-(\d{2})(?:T|\b)/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);

  m = new RegExp(`\\b${MONTH_NAME}\\.? (\\d{1,2}),? (\\d{4})\\b`, "i").exec(s);
  if (m) return isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);

  m = new RegExp(`\\b(\\d{1,2}) ${MONTH_NAME}\\.? (\\d{4})\\b`, "i").exec(s);
  if (m) return isoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);

  m = /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);

  m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(s);
  if (m) return isoDate(+m[3], +m[1], +m[2]);

  return null;
}

/** YYYY-MM-DD of a Date in UTC. */
export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** MM/DD/YYYY of a Date in UTC (the Eighth Circuit's by-date query). */
export function usDate(date: Date): string {
  const iso = utcDate(date);
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
}

/** The date `days` before `date` (UTC calendar arithmetic). */
export function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}
