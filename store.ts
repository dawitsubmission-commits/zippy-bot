// ZIPPY shop storage: cafeterias, menu and carts (Cloudflare D1), and the handler for shop buttons.

import {
  CART_EXPIRY_SECONDS,
  MAX_QTY_PER_ITEM,
  cafeteriaComingSoonScreen,
  cafeteriaSelectionScreen,
  cartScreen,
  emptyCartScreen,
  foodMenuScreen,
  parseShopCallback,
  type CafeteriaView,
  type CartLine,
  type MenuItemView,
} from "./cart";
import type { Db } from "./db";
import { describeStatus, getOrderingStatus } from "./schedule";
import type { Screen } from "./screens";

type Row = Record<string, unknown>;

// ---------- reading the catalogue ----------

export async function listCafeterias(db: Db): Promise<CafeteriaView[]> {
  const { results } = await db
    .prepare("SELECT id, name, active FROM cafeterias ORDER BY sort_order, id")
    .all<Row>();
  return results.map((r) => ({ id: Number(r.id), name: String(r.name), active: Number(r.active) === 1 }));
}

export async function getCafeteria(db: Db, id: number): Promise<CafeteriaView | null> {
  const r = await db.prepare("SELECT id, name, active FROM cafeterias WHERE id = ?").bind(id).first<Row>();
  return r ? { id: Number(r.id), name: String(r.name), active: Number(r.active) === 1 } : null;
}

// Archived items are hidden from customers completely.
export async function listMenu(db: Db, cafeteriaId: number): Promise<MenuItemView[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name, price_santim, available FROM menu_items WHERE cafeteria_id = ? AND archived = 0 ORDER BY sort_order, id",
    )
    .bind(cafeteriaId)
    .all<Row>();
  return results.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    priceSantim: Number(r.price_santim),
    available: Number(r.available) === 1,
  }));
}

type ItemInfo = { id: number; cafeteriaId: number; usable: boolean };

async function getItem(db: Db, id: number): Promise<ItemInfo | null> {
  const r = await db
    .prepare(
      "SELECT mi.id, mi.cafeteria_id, mi.available, mi.archived, c.active AS cafeteria_active FROM menu_items mi JOIN cafeterias c ON c.id = mi.cafeteria_id WHERE mi.id = ?",
    )
    .bind(id)
    .first<Row>();
  if (!r) return null;
  return {
    id: Number(r.id),
    cafeteriaId: Number(r.cafeteria_id),
    usable: Number(r.available) === 1 && Number(r.archived) === 0 && Number(r.cafeteria_active) === 1,
  };
}

// The delivery fee is a stored setting (ETB 10 = 1000 santim). Fails loudly if it is missing or invalid.
export async function getFeePerPortion(db: Db): Promise<number> {
  const r = await db
    .prepare("SELECT value FROM settings WHERE key = 'delivery_fee_per_portion_santim'")
    .first<{ value: string }>();
  const fee = Number(r?.value);
  if (!r || !Number.isSafeInteger(fee) || fee < 0) throw new Error("Delivery fee setting is missing or invalid");
  return fee;
}

// ---------- carts ----------

export type LoadedCart = { cafeteriaId: number | null; lines: CartLine[]; portions: number };

const EMPTY_CART: LoadedCart = { cafeteriaId: null, lines: [], portions: 0 };

// Loads the customer's cart. A cart untouched for too long is cleared here.
export async function loadCart(db: Db, userId: number, now: number): Promise<LoadedCart> {
  const cart = await db
    .prepare("SELECT cafeteria_id, updated_at FROM carts WHERE telegram_user_id = ?")
    .bind(userId)
    .first<Row>();
  if (!cart) return EMPTY_CART;
  if (Number(cart.updated_at) < now - CART_EXPIRY_SECONDS) {
    await db.batch([
      db.prepare("DELETE FROM cart_items WHERE telegram_user_id = ?").bind(userId),
      db.prepare("DELETE FROM carts WHERE telegram_user_id = ?").bind(userId),
    ]);
    return EMPTY_CART;
  }
  const { results } = await db
    .prepare(
      "SELECT ci.menu_item_id, ci.quantity, mi.name, mi.price_santim, mi.available, mi.archived, c.active AS cafeteria_active " +
        "FROM cart_items ci JOIN menu_items mi ON mi.id = ci.menu_item_id JOIN cafeterias c ON c.id = mi.cafeteria_id " +
        "WHERE ci.telegram_user_id = ? ORDER BY mi.sort_order, mi.id",
    )
    .bind(userId)
    .all<Row>();
  const lines: CartLine[] = results.map((r) => ({
    itemId: Number(r.menu_item_id),
    name: String(r.name),
    unitSantim: Number(r.price_santim),
    quantity: Number(r.quantity),
    available: Number(r.available) === 1 && Number(r.archived) === 0 && Number(r.cafeteria_active) === 1,
  }));
  return {
    cafeteriaId: Number(cart.cafeteria_id),
    lines,
    portions: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

export type AddResult =
  | { ok: true; quantity: number }
  | { ok: false; reason: "unavailable" | "other_cafeteria" | "at_max" };

export async function addToCart(
  db: Db,
  userId: number,
  itemId: number,
  now: number,
  maxQty: number = MAX_QTY_PER_ITEM,
): Promise<AddResult> {
  const item = await getItem(db, itemId);
  if (!item || !item.usable) return { ok: false, reason: "unavailable" };
  const cart = await loadCart(db, userId, now);
  if (cart.lines.length > 0 && cart.cafeteriaId !== item.cafeteriaId) {
    return { ok: false, reason: "other_cafeteria" };
  }
  const existing = cart.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
  if (existing >= maxQty) return { ok: false, reason: "at_max" };
  await db.batch([
    db
      .prepare(
        "INSERT INTO carts (telegram_user_id, cafeteria_id, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (telegram_user_id) DO UPDATE SET cafeteria_id = excluded.cafeteria_id, updated_at = excluded.updated_at",
      )
      .bind(userId, item.cafeteriaId, now),
    // The WHERE makes the database itself refuse to go past the maximum, even if two taps race.
    db
      .prepare(
        "INSERT INTO cart_items (telegram_user_id, menu_item_id, quantity) VALUES (?, ?, 1) " +
          "ON CONFLICT (telegram_user_id, menu_item_id) DO UPDATE SET quantity = quantity + 1 WHERE quantity < ?",
      )
      .bind(userId, itemId, maxQty),
  ]);
  return { ok: true, quantity: existing + 1 };
}

export async function removeFromCart(db: Db, userId: number, itemId: number, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM cart_items WHERE telegram_user_id = ? AND menu_item_id = ?").bind(userId, itemId),
    db.prepare("UPDATE carts SET updated_at = ? WHERE telegram_user_id = ?").bind(now, userId),
    // An empty cart is not kept.
    db
      .prepare(
        "DELETE FROM carts WHERE telegram_user_id = ? AND NOT EXISTS (SELECT 1 FROM cart_items WHERE telegram_user_id = ?)",
      )
      .bind(userId, userId),
  ]);
}

// "Decrease" at quantity 1 removes the item.
export async function decreaseInCart(db: Db, userId: number, itemId: number, now: number): Promise<void> {
  const cart = await loadCart(db, userId, now);
  const existing = cart.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
  if (existing === 0) return;
  if (existing === 1) {
    await removeFromCart(db, userId, itemId, now);
    return;
  }
  await db.batch([
    db
      .prepare("UPDATE cart_items SET quantity = quantity - 1 WHERE telegram_user_id = ? AND menu_item_id = ? AND quantity > 1")
      .bind(userId, itemId),
    db.prepare("UPDATE carts SET updated_at = ? WHERE telegram_user_id = ?").bind(now, userId),
  ]);
}

// ---------- the handler for shop buttons ----------

export type ShopResult = { screen?: Screen; toast?: string; alert?: boolean; next?: "checkout" };

async function selectionScreen(db: Db, userId: number, now: number): Promise<Screen> {
  const [cafeterias, cart, status] = await Promise.all([listCafeterias(db), loadCart(db, userId, now), getOrderingStatus(db, now)]);
  return cafeteriaSelectionScreen(cafeterias, cart.portions, describeStatus(status));
}

async function menuScreen(db: Db, userId: number, cafeteriaId: number, now: number): Promise<Screen | null> {
  const cafeteria = await getCafeteria(db, cafeteriaId);
  if (!cafeteria) return null;
  if (!cafeteria.active) return cafeteriaComingSoonScreen(cafeteria.name);
  const [items, cart, fee, status] = await Promise.all([
    listMenu(db, cafeteria.id),
    loadCart(db, userId, now),
    getFeePerPortion(db),
    getOrderingStatus(db, now),
  ]);
  return foodMenuScreen(cafeteria, items, cart.portions, fee, describeStatus(status));
}

export async function currentCartScreen(
  db: Db,
  userId: number,
  now: number,
): Promise<{ screen: Screen; hasUnavailable: boolean; orderingOpen: boolean; statusLine: string; lineCount: number }> {
  const status = await getOrderingStatus(db, now);
  const statusLine = describeStatus(status);
  const cart = await loadCart(db, userId, now);
  const empty = { screen: emptyCartScreen(), hasUnavailable: false, orderingOpen: status.open, statusLine, lineCount: 0 };
  if (cart.cafeteriaId === null || cart.lines.length === 0) return empty;
  const [cafeteria, fee] = await Promise.all([getCafeteria(db, cart.cafeteriaId), getFeePerPortion(db)]);
  if (!cafeteria) return empty;
  return {
    screen: cartScreen(cafeteria, cart.lines, fee, { statusLine, orderingOpen: status.open }),
    hasUnavailable: cart.lines.some((l) => !l.available),
    orderingOpen: status.open,
    statusLine,
    lineCount: cart.lines.length,
  };
}

// Returns null when the button is not a shop button. The customer is always taken from Telegram,
// never from the button, so nobody can touch another person's cart.
export async function handleShop(db: Db, userId: number, data: string, now: number): Promise<ShopResult | null> {
  const cb = parseShopCallback(data);
  if (!cb) return null;

  switch (cb.kind) {
    case "noop":
      return {};
    case "selection":
      return { screen: await selectionScreen(db, userId, now) };
    case "cafeteria": {
      const screen = await menuScreen(db, userId, cb.id, now);
      return screen ? { screen } : { screen: await selectionScreen(db, userId, now), toast: "That cafeteria isn't available." };
    }
    case "add": {
      const item = await getItem(db, cb.id);
      const result = await addToCart(db, userId, cb.id, now);
      const cafeteriaId = item?.cafeteriaId;
      const screen = cafeteriaId !== undefined ? await menuScreen(db, userId, cafeteriaId, now) : null;
      const shown = screen ?? (await selectionScreen(db, userId, now));
      if (result.ok) {
        const cart = await loadCart(db, userId, now);
        const line = cart.lines.find((l) => l.itemId === cb.id);
        return { screen: shown, toast: `Added: ${line?.name ?? "item"} × ${result.quantity}` };
      }
      if (result.reason === "at_max") {
        return { screen: shown, toast: `You can order up to ${MAX_QTY_PER_ITEM} portions of one food.` };
      }
      if (result.reason === "other_cafeteria") {
        return { screen: shown, toast: "Your cart has food from another cafeteria." };
      }
      return { screen: shown, toast: "That item isn't available right now." };
    }
    case "unavailable": {
      const item = await getItem(db, cb.id);
      const screen = item ? await menuScreen(db, userId, item.cafeteriaId, now) : null;
      return { screen: screen ?? (await selectionScreen(db, userId, now)), toast: "That item isn't available right now." };
    }
    case "cart":
      return { screen: (await currentCartScreen(db, userId, now)).screen };
    case "inc": {
      const result = await addToCart(db, userId, cb.id, now);
      const { screen } = await currentCartScreen(db, userId, now);
      if (result.ok) return { screen };
      if (result.reason === "at_max") return { screen, toast: `You can order up to ${MAX_QTY_PER_ITEM} portions of one food.` };
      return { screen, toast: "That item isn't available right now." };
    }
    case "dec": {
      await decreaseInCart(db, userId, cb.id, now);
      return { screen: (await currentCartScreen(db, userId, now)).screen };
    }
    case "remove": {
      await removeFromCart(db, userId, cb.id, now);
      return { screen: (await currentCartScreen(db, userId, now)).screen };
    }
    case "checkout": {
      const { screen, hasUnavailable, orderingOpen, statusLine, lineCount } = await currentCartScreen(db, userId, now);
      // Checks happen here on the server: a closed schedule always wins over whatever button was tapped.
      if (!orderingOpen) return { screen, toast: `${statusLine}\nYour cart is saved.`, alert: true };
      if (hasUnavailable) return { screen, toast: "Remove the unavailable items first.", alert: true };
      if (lineCount === 0) return { screen };
      return { screen, next: "checkout" }; // the bot now starts the checkout steps (see checkout.ts)
    }
  }
}
