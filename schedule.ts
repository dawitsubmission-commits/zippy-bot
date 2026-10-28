// ZIPPY ordering schedule: is ordering open right now, and how to say so in Ethiopian time.
// The decision is always made here on the server, never from the customer's phone.

import { WEEKDAY_NAMES, WEEKDAY_SHORT, etTime, etTimeFromEpoch } from "./schedule-text";
import { formatEthiopianRange, formatInternational, localTime, type LocalTime } from "./clock";
import type { Db } from "./db";
import type { Screen } from "./screens";
import { CB } from "./screens";

type Row = Record<string, unknown>;

export type Window = { id: number; name: string; openMinute: number; closeMinute: number };
export type Override = { mode: "open" | "closed"; until: number };
export type Schedule = { windows: Window[]; openWeekdays: number[]; closures: Set<string>; override: Override | null };

export type NextOpening = { dayOffset: number; weekday: number; minute: number; name: string };
export type OrderingStatus = {
  open: boolean;
  kind: "override_open" | "override_closed" | "closure" | "weekday_closed" | "window" | "outside_window";
  window?: Window;
  overrideUntil?: { epoch: number; dayOffset: number; weekday: number };
  next?: NextOpening;
};

// ---------- reading the schedule ----------

export async function loadSchedule(db: Db, now: number): Promise<Schedule> {
  const [windows, weekdays, closures, override] = await Promise.all([
    db.prepare("SELECT id, name, open_minute, close_minute FROM schedule_windows ORDER BY open_minute, id").all<Row>(),
    db.prepare("SELECT value FROM settings WHERE key = 'open_weekdays'").first<{ value: string }>(),
    db.prepare("SELECT date FROM closures").all<Row>(),
    db.prepare("SELECT mode, until FROM schedule_override WHERE id = 1").first<Row>(),
  ]);
  const openWeekdays = (weekdays?.value ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  const active = override && Number(override.until) > now ? { mode: String(override.mode) as "open" | "closed", until: Number(override.until) } : null;
  return {
    windows: windows.results.map((r) => ({ id: Number(r.id), name: String(r.name), openMinute: Number(r.open_minute), closeMinute: Number(r.close_minute) })),
    openWeekdays,
    closures: new Set(closures.results.map((r) => String(r.date))),
    override: active, // an expired override is simply ignored
  };
}

// ---------- the rules (pure) ----------

const pad2 = (n: number) => String(n).padStart(2, "0");
export const dateKey = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

function addDays(t: LocalTime, days: number): { key: string; weekday: number } {
  const date = new Date(Date.UTC(t.year, t.month - 1, t.day) + days * 86_400_000);
  const dow = date.getUTCDay();
  return { key: dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()), weekday: dow === 0 ? 7 : dow };
}

function daysBetween(a: LocalTime, b: LocalTime): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

// Open from the opening moment up to, but NOT including, the closing moment.
export function computeStatus(schedule: Schedule, now: number): OrderingStatus {
  const local = localTime(now);
  const next = findNext(schedule, local);

  if (schedule.override) {
    const until = localTime(schedule.override.until);
    const overrideUntil = { epoch: schedule.override.until, dayOffset: daysBetween(local, until), weekday: until.weekday };
    return schedule.override.mode === "open"
      ? { open: true, kind: "override_open", overrideUntil }
      : { open: false, kind: "override_closed", overrideUntil, next };
  }
  if (schedule.closures.has(dateKey(local.year, local.month, local.day))) return { open: false, kind: "closure", next };
  if (!schedule.openWeekdays.includes(local.weekday)) return { open: false, kind: "weekday_closed", next };
  const window = schedule.windows.find((w) => w.openMinute * 60 <= local.secondOfDay && local.secondOfDay < w.closeMinute * 60);
  if (window) return { open: true, kind: "window", window };
  return { open: false, kind: "outside_window", next };
}

function findNext(schedule: Schedule, local: LocalTime): NextOpening | undefined {
  for (let offset = 0; offset <= 14; offset++) {
    const day = addDays(local, offset);
    if (schedule.closures.has(day.key) || !schedule.openWeekdays.includes(day.weekday)) continue;
    for (const w of schedule.windows) {
      if (offset === 0 && w.openMinute * 60 <= local.secondOfDay) continue; // already started today
      return { dayOffset: offset, weekday: day.weekday, minute: w.openMinute, name: w.name };
    }
  }
  return undefined;
}

export async function getOrderingStatus(db: Db, now: number): Promise<OrderingStatus> {
  return computeStatus(await loadSchedule(db, now), now);
}

// ---------- how it is said to customers (always Ethiopian time) ----------

function dayWord(dayOffset: number, weekday: number): string {
  return dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow" : `on ${WEEKDAY_NAMES[weekday]}`;
}

function nextText(next: NextOpening | undefined): string {
  return next ? ` ${next.name} opens ${dayWord(next.dayOffset, next.weekday)} at ${etTime(next.minute)}.` : "";
}

export function describeStatus(status: OrderingStatus): string {
  switch (status.kind) {
    case "window":
      return `🟢 Ordering is open now (${status.window!.name}). It closes at ${etTime(status.window!.closeMinute)}.`;
    case "override_open": {
      const u = status.overrideUntil!;
      return `🟢 Ordering is open until ${etTimeFromEpoch(u.epoch)} ${dayWord(u.dayOffset, u.weekday)}.`;
    }
    case "override_closed":
      return `🔴 Ordering is temporarily closed.${nextText(status.next)}`;
    case "closure":
      return `🔴 Ordering is closed today.${nextText(status.next)}`;
    default:
      return `🔴 Ordering is closed.${nextText(status.next)}`;
  }
}

// ---------- the read-only admin screen (editing comes next) ----------

export async function hoursScreen(db: Db, now: number): Promise<Screen> {
  const schedule = await loadSchedule(db, now);
  const showIntl = (await db.prepare("SELECT value FROM settings WHERE key = 'admin_show_international'").first<{ value: string }>())?.value === "1";
  const status = computeStatus(schedule, now);

  const hours = schedule.windows.map((w) => {
    const intl = showIntl ? `   (${formatInternational(w.openMinute)}–${formatInternational(w.closeMinute)} normal clock)` : "";
    return `${w.name}: ${formatEthiopianRange(w.openMinute, w.closeMinute)}${intl}`;
  });
  const open = schedule.openWeekdays.slice().sort();
  const closedDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => !open.includes(d));
  const closures = [...schedule.closures].sort();
  const override = schedule.override
    ? `${schedule.override.mode === "open" ? "Open" : "Closed"} until ${etTimeFromEpoch(schedule.override.until)} (Ethiopian time)`
    : "none";

  return {
    text: [
      "🕒 Opening Hours & Availability",
      "",
      "Ordering hours (Ethiopian time):",
      ...hours,
      "",
      `Open days: ${open.length ? open.map((d) => WEEKDAY_SHORT[d]).join(", ") : "none"}`,
      `Closed days: ${closedDays.length ? closedDays.map((d) => WEEKDAY_SHORT[d]).join(", ") : "none"}`,
      `Special closures: ${closures.length ? closures.join(", ") : "none"}`,
      `Temporary override: ${override}`,
      "",
      `Right now: ${describeStatus(status)}`,
    ].join("\n"),
    buttons: [
      ...schedule.windows.map((w) => [{ text: `✏️ Edit ${w.name} hours`, data: `a:hw:${w.id}` }]),
      [
        { text: "📅 Open days", data: "a:hd" },
        { text: "🚫 Special closures", data: "a:hc" },
      ],
      [
        { text: "🟢 Open Now", data: "a:on" },
        { text: "🔴 Close Now", data: "a:cl" },
      ],
      ...(schedule.override ? [[{ text: "↩️ Resume Normal Schedule", data: "a:rs" }]] : []),
      [{ text: showIntl ? "🌐 Hide normal-clock times" : "🌐 Show normal-clock times", data: "a:hi" }],
      [{ text: "⬅ Admin Panel", data: CB.adminHome }],
    ],
  };
}
