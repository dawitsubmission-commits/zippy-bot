// Ethiopian clock helpers. The REAL time zone stays Africa/Addis_Ababa (UTC+3, no daylight saving).
// The Ethiopian clock is only a way of WRITING the time for people:
//   Ethiopian hour = (normal hour - 6), so 08:00 is "2:00" and 16:00 is "10:00".
// The Ethiopian "daytime" half runs from 06:00 to 18:00, the "nighttime" half from 18:00 to 06:00.

export const TIME_ZONE = "Africa/Addis_Ababa";

// PROVISIONAL wording: the owner has not confirmed these words yet. Easy to change here.
export const PERIOD_LABEL = { day: "daytime", night: "nighttime" } as const;

export type Period = "day" | "night";
export type LocalTime = { year: number; month: number; day: number; weekday: number; secondOfDay: number };

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// A moment in time (seconds since 1970) -> the date and time on the clock in Addis Ababa.
// weekday: 1 = Monday ... 7 = Sunday.
export function localTime(epochSeconds: number): LocalTime {
  const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return { year, month, day, weekday: dow === 0 ? 7 : dow, secondOfDay: get("hour") * 3600 + get("minute") * 60 + get("second") };
}

// Normal minute of the day (0..1439) -> Ethiopian clock reading.
export function toEthiopian(minuteOfDay: number): { hour: number; minute: number; period: Period } {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439) throw new Error("Invalid minute of day");
  const h = Math.floor(minuteOfDay / 60);
  let eth = (((h - 6) % 12) + 12) % 12;
  if (eth === 0) eth = 12;
  return { hour: eth, minute: minuteOfDay % 60, period: h >= 6 && h < 18 ? "day" : "night" };
}

// Ethiopian clock reading -> normal minute of the day. Returns null for an impossible reading.
// Telling "2:00 daytime" (08:00) from "2:00 nighttime" (20:00) is exactly why the period is required.
export function fromEthiopian(hour: number, minute: number, period: Period): number | null {
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (period !== "day" && period !== "night") return null;
  const normalHour = period === "day" ? (hour % 12) + 6 : ((hour % 12) + 18) % 24;
  return normalHour * 60 + minute;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// "2:00 daytime"
export function formatEthiopian(minuteOfDay: number): string {
  const t = toEthiopian(minuteOfDay);
  return `${t.hour}:${pad2(t.minute)} ${PERIOD_LABEL[t.period]}`;
}

// "2:00 – 5:30 daytime" (the period is written once when both ends share it)
export function formatEthiopianRange(startMinute: number, endMinute: number): string {
  const a = toEthiopian(startMinute);
  const b = toEthiopian(endMinute === 1440 ? 0 : endMinute);
  const left = `${a.hour}:${pad2(a.minute)}`;
  const right = `${b.hour}:${pad2(b.minute)}`;
  return a.period === b.period
    ? `${left} – ${right} ${PERIOD_LABEL[a.period]}`
    : `${left} ${PERIOD_LABEL[a.period]} – ${right} ${PERIOD_LABEL[b.period]}`;
}

// "08:00" (normal 24-hour clock; shown to the admin only, as a double-check)
export function formatInternational(minuteOfDay: number): string {
  return `${pad2(Math.floor((minuteOfDay % 1440) / 60))}:${pad2(minuteOfDay % 60)}`;
}
