// ZIPPY admin tools: manage the food menu, cafeterias and delivery fee from Telegram buttons.
// Every function here is only reached for an admin: bot.ts checks the Telegram ID on the server first.
// Every change is confirmed by the admin and written to the audit log in the same all-or-nothing step.

import { formatEtb } from "./cart";
import { applyHoursAction, handleHoursCallback, handleHoursText, isHoursAction, isHoursStep } from "./admin-hours";
import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, CANCEL, clearState, confirmScreen, getState, promptScreen, setState,
  type AdminState, type BasicAction, type Outcome,
} from "./admin-state";
import type { Db } from "./db";
import { adminPanel, type Screen } from "./screens";
import { getCafeteria, getFeePerPortion, listCafeterias, listMenu } from "./store";

type Row = Record<string, unknown>;

// ---------- input checks ----------

// Sanity limits against typing mistakes (these are not business rules).
export const MAX_FOOD_PRICE_SANTIM = 100_000 * 100;
export const MAX_FEE_SANTIM = 1_000 * 100;
export const MAX_NAME_LENGTH = 60;
const ADMIN_STATE_SECONDS = 15 * 60;

// "150" -> 15000, "150.5" -> 15050, "ETB 150.50" -> 15050. Anything else -> null. Whole santim only.
export function parseEtbToSantim(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/^ETB\s*/i, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}

// The name is kept exactly as typed (only spaces at the very start and end are removed).
export function validateFoodName(input: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.trim();
  if (name.length === 0) return { ok: false, error: "The name can't be empty." };
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(name)) return { ok: false, error: "The name must be on one line." };
  if (name.startsWith("/")) return { ok: false, error: "The name can't start with /." };
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false, error: `The name must be at most ${MAX_NAME_LENGTH} characters.` };
  return { ok: true, name };
}

export { getState, type AdminState };

// ---------- reading ----------

type Item = { id: number; cafeteriaId: number; name: string; priceSantim: number; available: boolean; archived: boolean };

async function getItem(db: Db, id: number): Promise<Item | null> {
  const r = await db
    .prepare("SELECT id, cafeteria_id, name, price_santim, available, archived FROM menu_items WHERE id = ?")
    .bind(id)
    .first<Row>();
  if (!r) return null;
  return {
    id: Number(r.id),
    cafeteriaId: Number(r.cafeteria_id),
    name: String(r.name),
    priceSantim: Number(r.price_santim),
    available: Number(r.available) === 1,
    archived: Number(r.archived) === 1,
  };
}

async function availableCount(db: Db, cafeteriaId: number): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM menu_items WHERE cafeteria_id = ? AND archived = 0 AND available = 1")
    .bind(cafeteriaId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// ---------- screens ----------


function menuPickerScreen(cafeterias: { id: number; name: string; active: boolean }[]): Screen {
  return {
    text: "🍛 Manage Food Menu\n\nChoose a cafeteria:",
    buttons: [
      ...cafeterias.map((c) => [{ text: c.active ? c.name : `${c.name} (closed)`, data: `a:mc:${c.id}` }]),
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

function statusIcon(available: boolean): string {
  return available ? "✅" : "❌";
}

function itemsScreen(cafeteria: { id: number; name: string }, items: Item[]): Screen {
  const lines = items.map(
    (i, n) => `${n + 1}. ${i.name} — ${formatEtb(i.priceSantim)} ${statusIcon(i.available)}${i.available ? "" : " unavailable"}`,
  );
  return {
    text: `🍛 ${cafeteria.name} — Menu\n\n${lines.length > 0 ? lines.join("\n") : "No foods yet."}\n\nTap a food to edit it.`,
    buttons: [
      ...items.map((i) => [{ text: `${i.name} — ${formatEtb(i.priceSantim)} ${statusIcon(i.available)}`, data: `a:mi:${i.id}` }]),
      [{ text: "➕ Add food", data: `a:af:${cafeteria.id}` }],
      [{ text: "⬅ Manage Food Menu", data: "a:menu" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

function itemScreen(item: Item): Screen {
  return {
    text: `🍛 ${item.name}\n\nPrice: ${formatEtb(item.priceSantim)}\nStatus: ${item.available ? "Available ✅" : "Unavailable ❌"}`,
    buttons: [
      [
        { text: "✏️ Edit name", data: `a:en:${item.id}` },
        { text: "💰 Edit price", data: `a:ep:${item.id}` },
      ],
      [{ text: item.available ? "❌ Mark unavailable" : "✅ Mark available", data: `a:tg:${item.id}` }],
      [{ text: "🗑 Remove from menu", data: `a:ar:${item.id}` }],
      [{ text: "⬅ Back to menu list", data: `a:mc:${item.cafeteriaId}` }],
    ],
  };
}

function cafeteriasScreen(cafeterias: { id: number; name: string; active: boolean }[]): Screen {
  return {
    text: "🍽️ Manage Cafeterias\n\nTap a cafeteria to open or close it.",
    buttons: [
      ...cafeterias.map((c) => [{ text: `${c.name} — ${c.active ? "Open ✅" : "Coming Soon ❌"}`, data: `a:cf:${c.id}` }]),
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

function cafeteriaScreen(c: { id: number; name: string; active: boolean }, available: number): Screen {
  return {
    text: `🍽️ ${c.name}\n\nStatus: ${c.active ? "Open for orders ✅" : "Coming Soon ❌"}\nAvailable foods: ${available}`,
    buttons: [
      [{ text: c.active ? "Close this cafeteria" : "Open this cafeteria", data: `a:cs:${c.id}` }],
      [{ text: "⬅ Manage Cafeterias", data: "a:cafes" }],
    ],
  };
}

async function phoneRequired(db: Db): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'require_phone'").first<{ value: string }>();
  return r?.value !== "0";
}

async function settingsScreen(db: Db): Promise<Screen> {
  const fee = await getFeePerPortion(db);
  const phone = await phoneRequired(db);
  return {
    text:
      `⚙️ Bot Settings\n\nDelivery fee: ${formatEtb(fee)} per portion\n` +
      `Phone number at the first order: ${phone ? "Required ✅" : "Not required ❌"}\n\nMore settings will be added in later steps.`,
    buttons: [
      [{ text: "💵 Change delivery fee", data: "a:fee" }],
      [{ text: phone ? "📱 Don't require a phone number" : "📱 Require a phone number", data: "a:ph" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function feePromptScreen(db: Db): Promise<Screen> {
  const fee = await getFeePerPortion(db);
  return promptScreen(
    `💵 Delivery fee\n\nCurrent fee: ${formatEtb(fee)} per portion.\n\nType the new fee in ETB (for example 10).`,
  );
}

// ---------- the guarded, audited changes ----------
// Each change is one all-or-nothing step: the audit row and the update both only happen if the
// value is still what the admin saw. If someone changed it meanwhile, neither happens.

async function applyAction(db: Db, adminId: number, action: BasicAction, now: number): Promise<Outcome> {
  const back = adminPanel();
  switch (action.type) {
    case "price": {
      const detail = JSON.stringify({ name: action.name, from: action.oldSantim, to: action.newSantim });
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'menu.price', ?, ? WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = ? AND price_santim = ?)")
          .bind(now, adminId, `menu_item:${action.itemId}`, detail, action.itemId, action.oldSantim),
        db
          .prepare("UPDATE menu_items SET price_santim = ? WHERE id = ? AND price_santim = ?")
          .bind(action.newSantim, action.itemId, action.oldSantim),
      ]);
      const item = await getItem(db, action.itemId);
      if (item && item.priceSantim === action.newSantim) {
        return { ok: true, message: `Price updated: ${action.name} is now ${formatEtb(action.newSantim)}.`, screen: itemScreen(item) };
      }
      return { ok: false, message: "The price changed in the meantime. Nothing was changed.", screen: item ? itemScreen(item) : back };
    }
    case "name": {
      const detail = JSON.stringify({ from: action.oldName, to: action.newName });
      try {
        await db.batch([
          db
            .prepare(AUDIT_SQL + "SELECT ?, ?, 'menu.rename', ?, ? WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = ? AND name = ?)")
            .bind(now, adminId, `menu_item:${action.itemId}`, detail, action.itemId, action.oldName),
          db
            .prepare("UPDATE menu_items SET name = ? WHERE id = ? AND name = ?")
            .bind(action.newName, action.itemId, action.oldName),
        ]);
      } catch {
        return { ok: false, message: "A food with that name already exists. Nothing was changed.", screen: back };
      }
      const item = await getItem(db, action.itemId);
      if (item && item.name === action.newName) {
        return { ok: true, message: "Name updated.", screen: itemScreen(item) };
      }
      return { ok: false, message: "The name changed in the meantime. Nothing was changed.", screen: item ? itemScreen(item) : back };
    }
    case "add": {
      const detail = JSON.stringify({ name: action.name, price: action.priceSantim });
      try {
        await db.batch([
          db
            .prepare(
              "INSERT INTO menu_items (cafeteria_id, name, price_santim, sort_order) VALUES (?, ?, ?, " +
                "COALESCE((SELECT MAX(sort_order) FROM menu_items WHERE cafeteria_id = ?), 0) + 1)",
            )
            .bind(action.cafeteriaId, action.name, action.priceSantim, action.cafeteriaId),
          db
            .prepare(AUDIT_SQL + "VALUES (?, ?, 'menu.add', ?, ?)")
            .bind(now, adminId, `cafeteria:${action.cafeteriaId}`, detail),
        ]);
      } catch {
        return { ok: false, message: "A food with that name already exists. Nothing was added.", screen: back };
      }
      const cafeteria = await getCafeteria(db, action.cafeteriaId);
      const items = await listMenu(db, action.cafeteriaId);
      const full: Item[] = items.map((m) => ({
        id: m.id, cafeteriaId: action.cafeteriaId, name: m.name, priceSantim: m.priceSantim, available: m.available, archived: false,
      }));
      return {
        ok: true,
        message: `Added: ${action.name} — ${formatEtb(action.priceSantim)}.`,
        screen: cafeteria ? itemsScreen(cafeteria, full) : back,
      };
    }
    case "archive": {
      const detail = JSON.stringify({ name: action.name });
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'menu.remove', ?, ? WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = ? AND archived = 0)")
          .bind(now, adminId, `menu_item:${action.itemId}`, detail, action.itemId),
        db.prepare("UPDATE menu_items SET archived = 1 WHERE id = ? AND archived = 0").bind(action.itemId),
      ]);
      const item = await getItem(db, action.itemId);
      const cafeteriaId = item?.cafeteriaId;
      const cafeteria = cafeteriaId !== undefined ? await getCafeteria(db, cafeteriaId) : null;
      if (item && item.archived && cafeteria) {
        const items = await listMenu(db, cafeteria.id);
        const full: Item[] = items.map((m) => ({
          id: m.id, cafeteriaId: cafeteria.id, name: m.name, priceSantim: m.priceSantim, available: m.available, archived: false,
        }));
        return { ok: true, message: `${action.name} was removed from the menu.`, screen: itemsScreen(cafeteria, full) };
      }
      return { ok: false, message: "Nothing was changed.", screen: back };
    }
    case "fee": {
      const detail = JSON.stringify({ from: action.oldSantim, to: action.newSantim });
      await db.batch([
        db
          .prepare(
            AUDIT_SQL +
              "SELECT ?, ?, 'settings.delivery_fee', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'delivery_fee_per_portion_santim' AND value = ?)",
          )
          .bind(now, adminId, detail, String(action.oldSantim)),
        db
          .prepare("UPDATE settings SET value = ? WHERE key = 'delivery_fee_per_portion_santim' AND value = ?")
          .bind(String(action.newSantim), String(action.oldSantim)),
      ]);
      const fee = await getFeePerPortion(db);
      if (fee === action.newSantim) {
        return { ok: true, message: `Delivery fee is now ${formatEtb(fee)} per portion.`, screen: await settingsScreen(db) };
      }
      return { ok: false, message: "The fee changed in the meantime. Nothing was changed.", screen: await settingsScreen(db) };
    }
    case "cafeteria": {
      const detail = JSON.stringify({ name: action.name, active: action.active });
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'cafeteria.active', ?, ? WHERE EXISTS (SELECT 1 FROM cafeterias WHERE id = ? AND active = ?)")
          .bind(now, adminId, `cafeteria:${action.cafeteriaId}`, detail, action.cafeteriaId, action.active ? 0 : 1),
        db
          .prepare("UPDATE cafeterias SET active = ? WHERE id = ? AND active = ?")
          .bind(action.active ? 1 : 0, action.cafeteriaId, action.active ? 0 : 1),
      ]);
      const c = await getCafeteria(db, action.cafeteriaId);
      if (c && c.active === action.active) {
        return {
          ok: true,
          message: `${c.name} is now ${c.active ? "open for orders" : "closed (Coming Soon)"}.`,
          screen: cafeteriaScreen(c, await availableCount(db, c.id)),
        };
      }
      return { ok: false, message: "Nothing was changed.", screen: back };
    }
  }
}

// ---------- the handler for admin buttons ----------

export type AdminResult = { screen?: Screen; toast?: string; alert?: boolean };

const SIMPLE = new Set(["a:menu", "a:cafes", "a:settings", "a:fee", "a:ph", "a:cy", "a:cn"]);

// Returns null for admin buttons this file does not handle (the placeholder screens).
export async function handleAdmin(db: Db, adminId: number, data: string, now: number): Promise<AdminResult | null> {
  // Opening-hours buttons live in admin-hours.ts.
  const hoursResult = await handleHoursCallback(db, adminId, data, now);
  if (hoursResult) return hoursResult;

  const m = /^a:(mc|mi|en|ep|tg|ar|af|cf|cs):(\d{1,9})$/.exec(data);
  if (!m && !SIMPLE.has(data)) return null;

  if (data === "a:menu") {
    await clearState(db, adminId);
    return { screen: menuPickerScreen(await listCafeterias(db)) };
  }
  if (data === "a:cafes") {
    await clearState(db, adminId);
    return { screen: cafeteriasScreen(await listCafeterias(db)) };
  }
  if (data === "a:settings") {
    await clearState(db, adminId);
    return { screen: await settingsScreen(db) };
  }
  if (data === "a:ph") {
    const old = (await phoneRequired(db)) ? "1" : "0";
    const next = old === "1" ? "0" : "1";
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'settings.require_phone', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'require_phone' AND value = ?)")
        .bind(now, adminId, JSON.stringify({ from: old, to: next }), old),
      db.prepare("UPDATE settings SET value = ? WHERE key = 'require_phone' AND value = ?").bind(next, old),
    ]);
    return {
      screen: await settingsScreen(db),
      toast: next === "1" ? "New customers must now share a phone number." : "A phone number is no longer required.",
    };
  }
  if (data === "a:fee") {
    await setState(db, adminId, { step: "fee" }, now);
    return { screen: await feePromptScreen(db) };
  }
  if (data === "a:cn") {
    await clearState(db, adminId);
    return { screen: adminPanel(), toast: "Cancelled." };
  }
  if (data === "a:cy") {
    const state = await getState(db, adminId, now);
    if (!state || state.step !== "confirm") {
      return { screen: adminPanel(), toast: "Nothing to confirm." };
    }
    await clearState(db, adminId); // clear first, so a double tap cannot apply it twice
    const outcome = isHoursAction(state.action)
      ? await applyHoursAction(db, adminId, state.action, now)
      : await applyAction(db, adminId, state.action, now);
    return { screen: outcome.screen, toast: outcome.message, alert: !outcome.ok };
  }

  const kind = m![1];
  const id = Number(m![2]);

  if (kind === "mc") {
    const cafeteria = await getCafeteria(db, id);
    if (!cafeteria) return { screen: adminPanel(), toast: "Cafeteria not found." };
    await clearState(db, adminId);
    const items = (await listMenu(db, id)).map((x) => ({ ...x, cafeteriaId: id, priceSantim: x.priceSantim, archived: false }));
    return { screen: itemsScreen(cafeteria, items) };
  }
  if (kind === "af") {
    const cafeteria = await getCafeteria(db, id);
    if (!cafeteria) return { screen: adminPanel(), toast: "Cafeteria not found." };
    await setState(db, adminId, { step: "new_name", cafeteriaId: id }, now);
    return { screen: promptScreen(`➕ Add food to ${cafeteria.name}\n\nType the food's name exactly as it should appear.`) };
  }
  if (kind === "cf" || kind === "cs") {
    const c = await getCafeteria(db, id);
    if (!c) return { screen: adminPanel(), toast: "Cafeteria not found." };
    if (kind === "cf") {
      await clearState(db, adminId);
      return { screen: cafeteriaScreen(c, await availableCount(db, c.id)) };
    }
    const makeActive = !c.active;
    const warn = makeActive && (await availableCount(db, c.id)) === 0 ? "\n\n⚠️ It has no available foods yet." : "";
    await setState(db, adminId, { step: "confirm", action: { type: "cafeteria", cafeteriaId: c.id, name: c.name, active: makeActive } }, now);
    return {
      screen: confirmScreen(
        makeActive
          ? `Open ${c.name} for orders?${warn}`
          : `Close ${c.name}?\n\nCustomers will see it as Coming Soon. Foods from it in carts will show as no longer available.`,
      ),
    };
  }

  // The remaining buttons are about one food.
  const item = await getItem(db, id);
  if (!item || item.archived) return { screen: adminPanel(), toast: "That food was not found." };

  switch (kind) {
    case "mi":
      await clearState(db, adminId);
      return { screen: itemScreen(item) };
    case "ep":
      await setState(db, adminId, { step: "price", itemId: item.id }, now);
      return {
        screen: promptScreen(
          `💰 Edit price — ${item.name}\n\nCurrent price: ${formatEtb(item.priceSantim)}\n\nType the new price in ETB (for example 150 or 150.50).`,
        ),
      };
    case "en":
      await setState(db, adminId, { step: "name", itemId: item.id }, now);
      return {
        screen: promptScreen(`✏️ Edit name\n\nCurrent name: ${item.name}\n\nType the new name exactly as it should appear.`),
      };
    case "tg": {
      const toAvailable = item.available ? 0 : 1;
      await db.batch([
        db
          .prepare(AUDIT_SQL + "SELECT ?, ?, 'menu.availability', ?, ? WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = ? AND available = ?)")
          .bind(now, adminId, `menu_item:${item.id}`, JSON.stringify({ name: item.name, available: toAvailable === 1 }), item.id, item.available ? 1 : 0),
        db.prepare("UPDATE menu_items SET available = ? WHERE id = ? AND available = ?").bind(toAvailable, item.id, item.available ? 1 : 0),
      ]);
      const fresh = (await getItem(db, item.id)) ?? item;
      return {
        screen: itemScreen(fresh),
        toast: fresh.available ? `${fresh.name} is available again.` : `${fresh.name} is now unavailable.`,
      };
    }
    case "ar":
      await setState(db, adminId, { step: "confirm", action: { type: "archive", itemId: item.id, name: item.name } }, now);
      return {
        screen: confirmScreen(
          `Remove ${item.name} from the menu?\n\nCustomers will no longer see it. Carts that contain it will show it as no longer available.`,
        ),
      };
  }
  return null;
}

// ---------- the handler for text the admin types ----------

// Returns null when the admin is not in the middle of anything (the bot then shows its normal hint).
export async function handleAdminText(db: Db, adminId: number, text: string, now: number): Promise<Screen | null> {
  const state = await getState(db, adminId, now);
  if (!state) return null;

  if (state.step === "confirm") {
    return { text: "Please tap Confirm or Cancel above, or send /cancel.", buttons: [] };
  }
  if (isHoursStep(state.step)) return handleHoursText(db, adminId, state, text, now);

  if (state.step === "price") {
    const item = await getItem(db, state.itemId);
    if (!item || item.archived) {
      await clearState(db, adminId);
      return { text: "That food was not found.", buttons: [[ADMIN_PANEL_BUTTON]] };
    }
    const santim = parseEtbToSantim(text);
    if (santim === null || santim <= 0 || santim > MAX_FOOD_PRICE_SANTIM) {
      return promptScreen("That isn't a valid price. Type a number like 150 or 150.50, or tap Cancel.");
    }
    if (santim === item.priceSantim) {
      return promptScreen(`That is already the current price (${formatEtb(item.priceSantim)}). Type a different price, or tap Cancel.`);
    }
    await setState(db, adminId, { step: "confirm", action: { type: "price", itemId: item.id, name: item.name, oldSantim: item.priceSantim, newSantim: santim } }, now);
    return confirmScreen(`Change the price of ${item.name}\nfrom ${formatEtb(item.priceSantim)} to ${formatEtb(santim)}?`);
  }

  if (state.step === "name") {
    const item = await getItem(db, state.itemId);
    if (!item || item.archived) {
      await clearState(db, adminId);
      return { text: "That food was not found.", buttons: [[ADMIN_PANEL_BUTTON]] };
    }
    const checked = validateFoodName(text);
    if (!checked.ok) return promptScreen(`${checked.error} Try again, or tap Cancel.`);
    if (checked.name === item.name) return promptScreen("That is already the current name. Type a different name, or tap Cancel.");
    await setState(db, adminId, { step: "confirm", action: { type: "name", itemId: item.id, oldName: item.name, newName: checked.name } }, now);
    return confirmScreen(`Rename\n"${item.name}"\nto\n"${checked.name}"?`);
  }

  if (state.step === "new_name") {
    const checked = validateFoodName(text);
    if (!checked.ok) return promptScreen(`${checked.error} Try again, or tap Cancel.`);
    await setState(db, adminId, { step: "new_price", cafeteriaId: state.cafeteriaId, name: checked.name }, now);
    return promptScreen(`➕ ${checked.name}\n\nNow type the price in ETB (for example 150).`);
  }

  if (state.step === "new_price") {
    const santim = parseEtbToSantim(text);
    if (santim === null || santim <= 0 || santim > MAX_FOOD_PRICE_SANTIM) {
      return promptScreen("That isn't a valid price. Type a number like 150 or 150.50, or tap Cancel.");
    }
    const cafeteria = await getCafeteria(db, state.cafeteriaId);
    if (!cafeteria) {
      await clearState(db, adminId);
      return { text: "Cafeteria not found.", buttons: [[ADMIN_PANEL_BUTTON]] };
    }
    await setState(db, adminId, { step: "confirm", action: { type: "add", cafeteriaId: cafeteria.id, name: state.name, priceSantim: santim } }, now);
    return confirmScreen(`Add this food to ${cafeteria.name}?\n\nName: ${state.name}\nPrice: ${formatEtb(santim)}`);
  }

  // step === "fee"
  const santim = parseEtbToSantim(text);
  if (santim === null || santim <= 0 || santim > MAX_FEE_SANTIM) {
    return promptScreen("That isn't a valid fee. Type a number above zero like 10, or tap Cancel.");
  }
  const old = await getFeePerPortion(db);
  if (santim === old) return promptScreen(`That is already the current fee (${formatEtb(old)}). Type a different fee, or tap Cancel.`);
  await setState(db, adminId, { step: "confirm", action: { type: "fee", oldSantim: old, newSantim: santim } }, now);
  return confirmScreen(
    `Change the delivery fee\nfrom ${formatEtb(old)} to ${formatEtb(santim)} per portion?\n\nFor example, 3 portions would pay ${formatEtb(3 * santim)} delivery.`,
  );
}
