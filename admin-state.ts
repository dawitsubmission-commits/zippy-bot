// Shared pieces for the admin tools: what the admin is in the middle of, and common screens.
// Kept in its own file so admin.ts and admin-hours.ts can both use it.

import type { Db } from "./db";
import { CB, type Button, type Screen } from "./screens";

type Row = Record<string, unknown>;

const ADMIN_STATE_SECONDS = 15 * 60;

// Changes to the menu, fee and cafeterias (see admin.ts).
export type BasicAction =
  | { type: "price"; itemId: number; name: string; oldSantim: number; newSantim: number }
  | { type: "name"; itemId: number; oldName: string; newName: string }
  | { type: "add"; cafeteriaId: number; name: string; priceSantim: number }
  | { type: "archive"; itemId: number; name: string }
  | { type: "fee"; oldSantim: number; newSantim: number }
  | { type: "cafeteria"; cafeteriaId: number; name: string; active: boolean };

// Changes to the opening hours (see admin-hours.ts).
export type HoursAction =
  | { type: "window"; windowId: number; name: string; oldOpen: number; oldClose: number; newOpen: number; newClose: number }
  | { type: "weekday"; day: number; oldValue: string; newValue: string }
  | { type: "closure_add"; date: string }
  | { type: "closure_remove"; date: string }
  | { type: "override"; mode: "open" | "closed"; until: number }
  | { type: "resume" };

export type PendingAction = BasicAction | HoursAction;

export type AdminState =
  | { step: "price"; itemId: number }
  | { step: "name"; itemId: number }
  | { step: "new_name"; cafeteriaId: number }
  | { step: "new_price"; cafeteriaId: number; name: string }
  | { step: "fee" }
  | { step: "win_open_time"; windowId: number }
  | { step: "win_open_period"; windowId: number; hour: number; minute: number }
  | { step: "win_close_time"; windowId: number; openMinute: number }
  | { step: "win_close_period"; windowId: number; openMinute: number; hour: number; minute: number }
  | { step: "closure_date" }
  | { step: "confirm"; action: PendingAction };

const STEPS = [
  "price", "name", "new_name", "new_price", "fee",
  "win_open_time", "win_open_period", "win_close_time", "win_close_period", "closure_date", "confirm",
];

export async function getState(db: Db, adminId: number, now: number): Promise<AdminState | null> {
  const row = await db
    .prepare("SELECT data, updated_at FROM admin_state WHERE telegram_user_id = ?")
    .bind(adminId)
    .first<Row>();
  if (!row) return null;
  if (Number(row.updated_at) < now - ADMIN_STATE_SECONDS) {
    await clearState(db, adminId);
    return null;
  }
  try {
    const state = JSON.parse(String(row.data)) as AdminState;
    if (state && typeof state === "object" && STEPS.includes(state.step)) return state;
  } catch {
    // fall through
  }
  await clearState(db, adminId);
  return null;
}

export async function setState(db: Db, adminId: number, state: AdminState, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO admin_state (telegram_user_id, data, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (telegram_user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
    .bind(adminId, JSON.stringify(state), now)
    .run();
}

export async function clearState(db: Db, adminId: number): Promise<void> {
  await db.prepare("DELETE FROM admin_state WHERE telegram_user_id = ?").bind(adminId).run();
}

// ---------- shared screens and SQL ----------

export const ADMIN_PANEL_BUTTON: Button = { text: "⬅ Admin Panel", data: CB.adminHome };
export const CANCEL: Button = { text: "✖ Cancel", data: "a:cn" };
export const CONFIRM_ROW: Button[] = [
  { text: "✅ Confirm", data: "a:cy" },
  { text: "✖ Cancel", data: "a:cn" },
];

export function promptScreen(text: string): Screen {
  return { text, buttons: [[CANCEL]] };
}

export function confirmScreen(text: string): Screen {
  return { text, buttons: [CONFIRM_ROW] };
}

export const AUDIT_SQL = "INSERT INTO audit_log (at, actor_telegram_id, action, target, details) ";

export type Outcome = { ok: boolean; message: string; screen: Screen };
