// ZIPPY admin tools for the opening hours. Only reached for an admin (bot.ts checks the Telegram ID first).
// Times are typed on the Ethiopian clock; the admin always chooses daytime or nighttime explicitly,
// because "2:00" alone could mean 08:00 or 20:00. Every change is confirmed and audited.

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, CANCEL, clearState, confirmScreen, promptScreen, setState,
  type AdminState, type HoursAction, type Outcome,
} from "./admin-state";
import { formatEthiopian, formatEthiopianRange, formatInternational, fromEthiopian, localTime } from "./clock";
import type { Db } from "./db";
import { dateKey, hoursScreen, loadSchedule } from "./schedule";
import { WEEKDAY_NAMES, etTimeFromEpoch } from "./schedule-text";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type HoursResult = { screen?: Screen; toast?: string; alert?: boolean };

const HOURS_STEPS = ["win_open_time", "win_open_period", "win_close_time", "win_close_period", "closure_date"];
const HOURS_ACTIONS = ["window", "weekday", "closure_add", "closure_remove", "override", "resume"];

export const isHoursStep = (step: string): boolean => HOURS_STEPS.includes(step);
export const isHoursAction = (action: { type: string }): action is HoursAction => HOURS_ACTIONS.includes(action.type);

// ---------- input checks ----------

// "2", "2:00", "10:30" -> Ethiopian hour 1..12 and minute. Daytime/nighttime is chosen separately.
export function parseClockInput(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return { hour, minute };
}

// "2026-11-12" -> the same text if it is a real calendar date, else null.
export function parseDate(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d) return null;
  return dateKey(y, mo, d);
}

const MAX_CLOSURE_DAYS_AHEAD = 400;

function daysFromToday(date: string, now: number): number {
  const [y, mo, d] = date.split("-").map(Number);
  const t = localTime(now);
  return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000);
}

function weekdayOf(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return WEEKDAY_NAMES[dow === 0 ? 7 : dow];
}

type Win = { id: number; name: string; openMinute: number; closeMinute: number };

async function getWindow(db: Db, id: number): Promise<Win | null> {
  const r = await db.prepare("SELECT id, name, open_minute, close_minute FROM schedule_windows WHERE id = ?").bind(id).first<Row>();
  return r ? { id: Number(r.id), name: String(r.name), openMinute: Number(r.open_minute), closeMinute: Number(r.close_minute) } : null;
}

// Why a new time range is not allowed, or null if it is fine.
async function windowProblem(db: Db, windowId: number, open: number, close: number): Promise<string | null> {
  if (open >= close) return "The closing time must be after the opening time on the same day.";
  const { results } = await db
    .prepare("SELECT name, open_minute, close_minute FROM schedule_windows WHERE id != ?")
    .bind(windowId)
    .all<Row>();
  for (const o of results) {
    if (open < Number(o.close_minute) && Number(o.open_minute) < close) {
      return `That overlaps the ${String(o.name)} hours (${formatEthiopianRange(Number(o.open_minute), Number(o.close_minute))}).`;
    }
  }
  return null;
}

async function showIntl(db: Db): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'admin_show_international'").first<{ value: string }>();
  return r?.value === "1";
}

async function rangeText(db: Db, open: number, close: number): Promise<string> {
  const base = formatEthiopianRange(open, close);
  return (await showIntl(db)) ? `${base}  (${formatInternational(open)}–${formatInternational(close)} normal clock)` : base;
}

async function getSetting(db: Db, key: string): Promise<string> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? "";
}

function openDays(value: string): number[] {
  return value.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

function dayWordFor(until: number, now: number): string {
  const a = localTime(now);
  const b = localTime(until);
  const diff = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
  return diff === 0 ? "today" : diff === 1 ? "tomorrow" : `on ${WEEKDAY_NAMES[b.weekday]}`;
}

const BACK_TO_HOURS: Button = { text: "⬅ Opening Hours", data: "a:hours" };
const PERIOD_ROW: Button[] = [
  { text: "☀️ Daytime", data: "a:pd" },
  { text: "🌙 Nighttime", data: "a:pn" },
];

// ---------- buttons ----------

export async function handleHoursCallback(db: Db, adminId: number, data: string, now: number): Promise<HoursResult | null> {
  if (data === "a:hours") {
    await clearState(db, adminId);
    return { screen: await hoursScreen(db, now) };
  }

  let m = /^a:hw:(\d{1,9})$/.exec(data);
  if (m) {
    const w = await getWindow(db, Number(m[1]));
    if (!w) return { screen: await hoursScreen(db, now), toast: "That ordering window was not found." };
    await setState(db, adminId, { step: "win_open_time", windowId: w.id }, now);
    return {
      screen: promptScreen(
        `✏️ Edit ${w.name} hours\n\nCurrent: ${await rangeText(db, w.openMinute, w.closeMinute)}\n\n` +
          "Type the new OPENING time on the Ethiopian clock, like 2:00 or 2:30.\n(You will choose daytime or nighttime next.)",
      ),
    };
  }

  if (data === "a:pd" || data === "a:pn") return handlePeriod(db, adminId, data === "a:pd" ? "day" : "night", now);

  if (data === "a:hd") {
    await clearState(db, adminId);
    return { screen: await daysScreen(db) };
  }
  m = /^a:wd:([1-7])$/.exec(data);
  if (m) {
    const day = Number(m[1]);
    const oldValue = await getSetting(db, "open_weekdays");
    const days = new Set(openDays(oldValue));
    const makeOpen = !days.has(day);
    if (makeOpen) days.add(day);
    else days.delete(day);
    const newValue = [...days].sort().join(",");
    await setState(db, adminId, { step: "confirm", action: { type: "weekday", day, oldValue, newValue } }, now);
    const warn = days.size === 0 ? "\n\n⚠️ This would leave ZIPPY closed every day." : "";
    return {
      screen: confirmScreen(
        makeOpen ? `Open ordering on ${WEEKDAY_NAMES[day]}s?` : `Close ordering on ${WEEKDAY_NAMES[day]}s?${warn}`,
      ),
    };
  }

  if (data === "a:hc") {
    await clearState(db, adminId);
    return { screen: await closuresScreen(db, now) };
  }
  if (data === "a:ca") {
    await setState(db, adminId, { step: "closure_date" }, now);
    return {
      screen: {
        text:
          "🚫 Add a special closure\n\nTap Today or Tomorrow, or type the date as YYYY-MM-DD (for example 2026-11-12).\nDates use the normal calendar.",
        buttons: [
          [
            { text: "Today", data: "a:ct" },
            { text: "Tomorrow", data: "a:cm" },
          ],
          [CANCEL],
        ],
      },
    };
  }
  if (data === "a:ct" || data === "a:cm") {
    const t = localTime(now + (data === "a:cm" ? 86_400 : 0));
    return { screen: await closureConfirm(db, adminId, dateKey(t.year, t.month, t.day), now) };
  }
  m = /^a:cx:(\d{4})(\d{2})(\d{2})$/.exec(data);
  if (m) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const exists = await db.prepare("SELECT date FROM closures WHERE date = ?").bind(date).first();
    if (!exists) return { screen: await closuresScreen(db, now), toast: "That closure was not found." };
    await setState(db, adminId, { step: "confirm", action: { type: "closure_remove", date } }, now);
    return { screen: confirmScreen(`Remove the special closure on ${date} (${weekdayOf(date)})?\n\nOrdering will follow the normal schedule that day.`) };
  }

  if (data === "a:on" || data === "a:cl") {
    const open = data === "a:on";
    const key = open ? "o" : "c";
    return {
      screen: {
        text: open
          ? "🟢 Open Now\n\nHow long should ordering stay open? It goes back to the normal schedule by itself afterwards."
          : "🔴 Close Now\n\nHow long should ordering stay closed? It goes back to the normal schedule by itself afterwards.",
        buttons: [
          [{ text: "30 minutes", data: `a:ov:${key}:30` }, { text: "1 hour", data: `a:ov:${key}:60` }],
          [{ text: "2 hours", data: `a:ov:${key}:120` }, { text: "4 hours", data: `a:ov:${key}:240` }],
          [{ text: "Until the end of today", data: `a:ov:${key}:eod` }],
          [BACK_TO_HOURS],
        ],
      },
    };
  }
  m = /^a:ov:(o|c):(\d{1,4}|eod)$/.exec(data);
  if (m) {
    const mode = m[1] === "o" ? "open" : "closed";
    const minutes = m[2] === "eod" ? null : Number(m[2]);
    if (minutes !== null && (minutes < 1 || minutes > 1440)) return { toast: "That duration isn't allowed." };
    const until = minutes === null ? now + (86_400 - localTime(now).secondOfDay) : now + minutes * 60;
    await setState(db, adminId, { step: "confirm", action: { type: "override", mode, until } }, now);
    const when = `${etTimeFromEpoch(until)} ${dayWordFor(until, now)}`;
    return {
      screen: confirmScreen(
        mode === "open"
          ? `Open ordering now, until ${when}?\n\nAfter that the normal schedule applies again.`
          : `Stop all ordering now, until ${when}?\n\nCustomers can still browse and keep their carts. After that the normal schedule applies again.`,
      ),
    };
  }
  if (data === "a:rs") {
    const has = await db.prepare("SELECT id FROM schedule_override WHERE id = 1").first();
    if (!has) return { screen: await hoursScreen(db, now), toast: "There is no temporary override." };
    await setState(db, adminId, { step: "confirm", action: { type: "resume" } }, now);
    return { screen: confirmScreen("Go back to the normal schedule?\n\nThe temporary Open Now / Close Now setting will be removed.") };
  }
  if (data === "a:hi") {
    const old = await showIntl(db);
    const next = old ? "0" : "1";
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'settings.admin_show_international', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'admin_show_international' AND value = ?)")
        .bind(now, adminId, JSON.stringify({ from: old ? "1" : "0", to: next }), old ? "1" : "0"),
      db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_show_international' AND value = ?").bind(next, old ? "1" : "0"),
    ]);
    return { screen: await hoursScreen(db, now), toast: next === "1" ? "Normal-clock times are shown to you." : "Normal-clock times are hidden." };
  }
  return null;
}

async function handlePeriod(db: Db, adminId: number, period: "day" | "night", now: number): Promise<HoursResult> {
  const row = await db.prepare("SELECT data FROM admin_state WHERE telegram_user_id = ?").bind(adminId).first<{ data: string }>();
  let state: AdminState | null = null;
  try {
    state = row ? (JSON.parse(row.data) as AdminState) : null;
  } catch {
    state = null;
  }
  if (!state || (state.step !== "win_open_period" && state.step !== "win_close_period")) {
    return { toast: "Nothing to choose right now." };
  }
  const minuteOfDay = fromEthiopian(state.hour, state.minute, period);
  if (minuteOfDay === null) return { toast: "That time isn't valid." };
  const w = await getWindow(db, state.windowId);
  if (!w) {
    await clearState(db, adminId);
    return { screen: await hoursScreen(db, now), toast: "That ordering window was not found." };
  }

  if (state.step === "win_open_period") {
    await setState(db, adminId, { step: "win_close_time", windowId: w.id, openMinute: minuteOfDay }, now);
    return {
      screen: promptScreen(
        `✏️ ${w.name}: opens at ${formatEthiopian(minuteOfDay)} (${formatInternational(minuteOfDay)} normal clock).\n\n` +
          "Now type the CLOSING time on the Ethiopian clock, like 5:30.\n(You will choose daytime or nighttime next.)",
      ),
    };
  }

  const open = state.openMinute;
  const problem = await windowProblem(db, w.id, open, minuteOfDay);
  if (problem) {
    await clearState(db, adminId);
    return {
      screen: { text: `⚠️ Not changed.\n\n${problem}\n\nNothing was changed. Start again from Opening Hours.`, buttons: [[BACK_TO_HOURS]] },
    };
  }
  await setState(
    db,
    adminId,
    { step: "confirm", action: { type: "window", windowId: w.id, name: w.name, oldOpen: w.openMinute, oldClose: w.closeMinute, newOpen: open, newClose: minuteOfDay } },
    now,
  );
  return {
    screen: confirmScreen(
      `Change the ${w.name} hours\nfrom ${await rangeText(db, w.openMinute, w.closeMinute)}\nto ${await rangeText(db, open, minuteOfDay)}?`,
    ),
  };
}

async function closureConfirm(db: Db, adminId: number, date: string, now: number): Promise<Screen> {
  const ahead = daysFromToday(date, now);
  if (ahead < 0) return promptScreen("That date is in the past. Type a date from today onwards (YYYY-MM-DD), or tap Cancel.");
  if (ahead > MAX_CLOSURE_DAYS_AHEAD) return promptScreen("That date is too far ahead. Type a nearer date (YYYY-MM-DD), or tap Cancel.");
  const exists = await db.prepare("SELECT date FROM closures WHERE date = ?").bind(date).first();
  if (exists) return promptScreen(`${date} is already a special closure. Type a different date, or tap Cancel.`);
  await setState(db, adminId, { step: "confirm", action: { type: "closure_add", date } }, now);
  return confirmScreen(`Close ordering all day on ${date} (${weekdayOf(date)})?`);
}

// ---------- screens ----------

async function daysScreen(db: Db): Promise<Screen> {
  const open = new Set(openDays(await getSetting(db, "open_weekdays")));
  return {
    text: "📅 Open days\n\nTap a day to open or close it. Open days are marked ✅.",
    buttons: [
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => [{ text: `${WEEKDAY_NAMES[d]} ${open.has(d) ? "✅" : "❌"}`, data: `a:wd:${d}` }]),
      [BACK_TO_HOURS],
    ],
  };
}

async function closuresScreen(db: Db, now: number): Promise<Screen> {
  const schedule = await loadSchedule(db, now);
  const t = localTime(now);
  const today = dateKey(t.year, t.month, t.day);
  const upcoming = [...schedule.closures].filter((d) => d >= today).sort();
  return {
    text: `🚫 Special closures\n\n${upcoming.length ? upcoming.map((d) => `${d} (${weekdayOf(d)})`).join("\n") : "None coming up."}\n\nTap a date to remove it.`,
    buttons: [
      ...upcoming.map((d) => [{ text: `❌ ${d}`, data: `a:cx:${d.replaceAll("-", "")}` }]),
      [{ text: "➕ Add closure", data: "a:ca" }],
      [BACK_TO_HOURS],
    ],
  };
}

// ---------- text typed by the admin ----------

export async function handleHoursText(db: Db, adminId: number, state: AdminState, text: string, now: number): Promise<Screen | null> {
  if (state.step === "win_open_time" || state.step === "win_close_time") {
    const t = parseClockInput(text);
    if (!t) return promptScreen("That isn't a valid time. Type the hour and minutes like 2:00 or 5:30 (hour 1 to 12), or tap Cancel.");
    const shown = `${t.hour}:${String(t.minute).padStart(2, "0")}`;
    const next: AdminState =
      state.step === "win_open_time"
        ? { step: "win_open_period", windowId: state.windowId, hour: t.hour, minute: t.minute }
        : { step: "win_close_period", windowId: state.windowId, openMinute: state.openMinute, hour: t.hour, minute: t.minute };
    await setState(db, adminId, next, now);
    return {
      text: `${state.step === "win_open_time" ? "Opening" : "Closing"} at ${shown}.\n\nIs that daytime or nighttime?`,
      buttons: [PERIOD_ROW, [CANCEL]],
    };
  }
  if (state.step === "win_open_period" || state.step === "win_close_period") {
    return { text: "Please tap Daytime or Nighttime above, or send /cancel.", buttons: [] };
  }
  if (state.step === "closure_date") {
    const date = parseDate(text);
    if (!date) return promptScreen("That isn't a valid date. Type it like 2026-11-12 (year-month-day), or tap Cancel.");
    return closureConfirm(db, adminId, date, now);
  }
  return null;
}

// ---------- applying a confirmed change (guarded + audited, all or nothing) ----------

export async function applyHoursAction(db: Db, adminId: number, action: HoursAction, now: number): Promise<Outcome> {
  const back = async (ok: boolean, message: string): Promise<Outcome> => ({ ok, message, screen: await hoursScreen(db, now) });

  switch (action.type) {
    case "window": {
      const problem = await windowProblem(db, action.windowId, action.newOpen, action.newClose);
      if (problem) return back(false, `Not changed. ${problem}`);
      const detail = JSON.stringify({ name: action.name, from: [action.oldOpen, action.oldClose], to: [action.newOpen, action.newClose] });
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'schedule.window', ?, ? WHERE EXISTS (SELECT 1 FROM schedule_windows WHERE id = ? AND open_minute = ? AND close_minute = ?)")
          .bind(now, adminId, `window:${action.windowId}`, detail, action.windowId, action.oldOpen, action.oldClose),
        db
          .prepare("UPDATE schedule_windows SET open_minute = ?, close_minute = ? WHERE id = ? AND open_minute = ? AND close_minute = ?")
          .bind(action.newOpen, action.newClose, action.windowId, action.oldOpen, action.oldClose),
      ]);
      const w = await getWindow(db, action.windowId);
      return w && w.openMinute === action.newOpen && w.closeMinute === action.newClose
        ? back(true, `${action.name} hours are now ${formatEthiopianRange(w.openMinute, w.closeMinute)}.`)
        : back(false, "The hours changed in the meantime. Nothing was changed.");
    }
    case "weekday": {
      const detail = JSON.stringify({ day: action.day, from: action.oldValue, to: action.newValue });
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'schedule.weekdays', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'open_weekdays' AND value = ?)")
          .bind(now, adminId, detail, action.oldValue),
        db.prepare("UPDATE settings SET value = ? WHERE key = 'open_weekdays' AND value = ?").bind(action.newValue, action.oldValue),
      ]);
      return (await getSetting(db, "open_weekdays")) === action.newValue
        ? back(true, "Open days updated.")
        : back(false, "The open days changed in the meantime. Nothing was changed.");
    }
    case "closure_add": {
      try {
        await db.batch([
          db.prepare("INSERT INTO closures (date, reason) VALUES (?, '')").bind(action.date),
          db.prepare(AUDIT_SQL + "VALUES (?, ?, 'schedule.closure_add', 'closures', ?)").bind(now, adminId, JSON.stringify({ date: action.date })),
        ]);
      } catch {
        return back(false, "That date is already a special closure. Nothing was changed.");
      }
      return back(true, `Ordering is closed all day on ${action.date}.`);
    }
    case "closure_remove": {
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'schedule.closure_remove', 'closures', ? WHERE EXISTS (SELECT 1 FROM closures WHERE date = ?)")
          .bind(now, adminId, JSON.stringify({ date: action.date }), action.date),
        db.prepare("DELETE FROM closures WHERE date = ?").bind(action.date),
      ]);
      return back(true, `The special closure on ${action.date} was removed.`);
    }
    case "override": {
      if (action.until <= now) return back(false, "That time has already passed. Nothing was changed.");
      await db.batch([
        db
          .prepare(AUDIT_SQL + "VALUES (?, ?, 'schedule.override', 'schedule_override', ?)")
          .bind(now, adminId, JSON.stringify({ mode: action.mode, until: action.until })),
        db
          .prepare(
            "INSERT INTO schedule_override (id, mode, until, set_by, set_at) VALUES (1, ?, ?, ?, ?) " +
              "ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, until = excluded.until, set_by = excluded.set_by, set_at = excluded.set_at",
          )
          .bind(action.mode, action.until, adminId, now),
      ]);
      return back(
        true,
        action.mode === "open"
          ? `Ordering is open until ${etTimeFromEpoch(action.until)} ${dayWordFor(action.until, now)}.`
          : `Ordering is closed until ${etTimeFromEpoch(action.until)} ${dayWordFor(action.until, now)}.`,
      );
    }
    case "resume": {
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'schedule.resume', 'schedule_override', '{}' WHERE EXISTS (SELECT 1 FROM schedule_override WHERE id = 1)")
          .bind(now, adminId),
        db.prepare("DELETE FROM schedule_override WHERE id = 1"),
      ]);
      return back(true, "Back to the normal schedule.");
    }
  }
}
