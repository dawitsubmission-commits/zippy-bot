// ZIPPY cart logic: money, pricing, and the screens for cafeteria selection, food menu and cart.
// Plain data and plain functions only (no Telegram library, no database), so it is easy to test.

import { CB, type Button, type Screen } from "./screens";

// PROVISIONAL values: the owner has not confirmed these yet. Easy to change here.
export const MAX_QTY_PER_ITEM = 10;
export const CART_EXPIRY_SECONDS = 24 * 60 * 60; // untouched carts are cleared after 24 hours

// ---------- money (whole santim only: 100 santim = 1 ETB; never decimals) ----------

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatEtb(santim: number): string {
  if (!Number.isSafeInteger(santim) || santim < 0) throw new Error("Invalid money amount");
  const whole = Math.floor(santim / 100);
  const cents = santim % 100;
  return cents === 0 ? `ETB ${group(whole)}` : `ETB ${group(whole)}.${String(cents).padStart(2, "0")}`;
}

export type CartLine = {
  itemId: number;
  name: string;
  unitSantim: number;
  quantity: number;
  available: boolean;
};

export type Pricing = { subtotal: number; portions: number; fee: number; total: number };

// Subtotal = sum(price x quantity). Delivery fee = portions x fee per portion. Total = subtotal + fee.
// Only available items are counted.
export function priceCart(lines: CartLine[], feePerPortion: number): Pricing {
  if (!Number.isSafeInteger(feePerPortion) || feePerPortion < 0) throw new Error("Invalid delivery fee");
  let subtotal = 0;
  let portions = 0;
  for (const line of lines) {
    if (!line.available) continue;
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new Error("Invalid quantity");
    if (!Number.isSafeInteger(line.unitSantim) || line.unitSantim < 1) throw new Error("Invalid price");
    subtotal += line.unitSantim * line.quantity;
    portions += line.quantity;
  }
  const fee = portions * feePerPortion;
  return { subtotal, portions, fee, total: subtotal + fee };
}

// ---------- callback codes (Telegram allows at most 64 bytes) ----------

export type ShopCallback =
  | { kind: "selection" }
  | { kind: "cafeteria"; id: number }
  | { kind: "add"; id: number }
  | { kind: "unavailable"; id: number }
  | { kind: "cart" }
  | { kind: "inc"; id: number }
  | { kind: "dec"; id: number }
  | { kind: "remove"; id: number }
  | { kind: "checkout" }
  | { kind: "noop" };

export const SHOP_CB = { cart: "v:cart", checkout: "k:go", noop: "x:noop" } as const;

export function parseShopCallback(data: string): ShopCallback | null {
  if (data === CB.cafe) return { kind: "selection" };
  if (data === SHOP_CB.cart) return { kind: "cart" };
  if (data === SHOP_CB.checkout) return { kind: "checkout" };
  if (data === SHOP_CB.noop) return { kind: "noop" };
  const m = /^(c|i|u|q\+|q-|qx):(\d{1,9})$/.exec(data);
  if (!m) return null;
  const id = Number(m[2]);
  switch (m[1]) {
    case "c":
      return { kind: "cafeteria", id };
    case "i":
      return { kind: "add", id };
    case "u":
      return { kind: "unavailable", id };
    case "q+":
      return { kind: "inc", id };
    case "q-":
      return { kind: "dec", id };
    default:
      return { kind: "remove", id };
  }
}

// ---------- screens ----------

const MAIN_MENU: Button = { text: "🏠 Main Menu", data: CB.main };
const BACK_TO_CAFETERIAS: Button = { text: "⬅ Back to Cafeteria Selection", data: CB.cafe };

export type CafeteriaView = { id: number; name: string; active: boolean };
export type MenuItemView = { id: number; name: string; priceSantim: number; available: boolean };

function viewCartButton(portions: number): Button {
  return { text: portions > 0 ? `🛒 View Cart (${portions})` : "🛒 View Cart", data: SHOP_CB.cart };
}

export function cafeteriaSelectionScreen(cafeterias: CafeteriaView[], cartPortions: number, statusLine?: string): Screen {
  const buttons: Button[][] = cafeterias.map((c) => [
    { text: c.active ? c.name : `${c.name} — Coming Soon`, data: `c:${c.id}` },
  ]);
  if (cartPortions > 0) buttons.push([viewCartButton(cartPortions)]);
  buttons.push([MAIN_MENU]);
  return { text: statusLine ? `🍱 Choose a Cafeteria\n\n${statusLine}` : "🍱 Choose a Cafeteria", buttons };
}

export function cafeteriaComingSoonScreen(name: string): Screen {
  return {
    text: `${name} — Coming Soon\n\nThis cafeteria isn't open for orders yet.`,
    buttons: [[BACK_TO_CAFETERIAS], [MAIN_MENU]],
  };
}

export function foodMenuScreen(
  cafeteria: { id: number; name: string },
  items: MenuItemView[],
  cartPortions: number,
  feePerPortion: number,
  statusLine?: string,
): Screen {
  const buttons: Button[][] = items.map((item) => [
    item.available
      ? { text: `${item.name} — ${formatEtb(item.priceSantim)}`, data: `i:${item.id}` }
      : { text: `${item.name} — unavailable`, data: `u:${item.id}` },
  ]);
  buttons.push([viewCartButton(cartPortions)]);
  buttons.push([BACK_TO_CAFETERIAS]);
  buttons.push([MAIN_MENU]);
  return {
    text:
      `🍽 ${cafeteria.name}\n\nTap a food to add one portion to your cart.\nDelivery fee: ${formatEtb(feePerPortion)} per portion.` +
      (statusLine ? `\n\n${statusLine}` : ""),
    buttons,
  };
}

export function emptyCartScreen(): Screen {
  return {
    text: "🛒 Your cart is empty.\n\nChoose a cafeteria and tap a food to add it.",
    buttons: [[BACK_TO_CAFETERIAS], [MAIN_MENU]],
  };
}

export type CartOptions = { statusLine?: string; orderingOpen?: boolean };

export function cartScreen(
  cafeteria: { id: number; name: string },
  lines: CartLine[],
  feePerPortion: number,
  options: CartOptions = {},
): Screen {
  if (lines.length === 0) return emptyCartScreen();
  const pricing = priceCart(lines, feePerPortion);
  const hasUnavailable = lines.some((l) => !l.available);
  const hasAvailable = lines.some((l) => l.available);

  const out: string[] = [`🛒 Your Cart — ${cafeteria.name}`, ""];
  lines.forEach((line, index) => {
    if (line.available) {
      out.push(`${index + 1}. ${line.name}`);
      out.push(`   ${line.quantity} × ${formatEtb(line.unitSantim)} = ${formatEtb(line.unitSantim * line.quantity)}`);
    } else {
      out.push(`${index + 1}. ⚠️ ${line.name} — no longer available`);
    }
  });
  out.push("");
  if (hasAvailable) {
    out.push(`Food subtotal: ${formatEtb(pricing.subtotal)}`);
    out.push(
      `Delivery fee (${pricing.portions} portion${pricing.portions === 1 ? "" : "s"} × ${formatEtb(feePerPortion)}): ${formatEtb(pricing.fee)}`,
    );
    out.push(`Total: ${formatEtb(pricing.total)}`);
  } else {
    out.push("None of the items in your cart are available right now.");
  }
  if (hasUnavailable) out.push("", "Remove the unavailable items to continue.");
  if (options.statusLine) out.push("", options.statusLine);

  const buttons: Button[][] = [];
  for (const line of lines) {
    if (line.available) {
      buttons.push([{ text: `${line.name} × ${line.quantity}`, data: SHOP_CB.noop }]);
      buttons.push([
        { text: "➖", data: `q-:${line.itemId}` },
        { text: "➕", data: `q+:${line.itemId}` },
        { text: "🗑 Remove", data: `qx:${line.itemId}` },
      ]);
    } else {
      buttons.push([{ text: `🗑 Remove ${line.name}`, data: `qx:${line.itemId}` }]);
    }
  }
  if (hasAvailable && !hasUnavailable) {
    // Browsing and editing the cart always work; only checkout is switched off while ordering is closed.
    const checkoutText = options.orderingOpen === false ? "🔒 Checkout (closed)" : "✅ Checkout";
    buttons.push([{ text: checkoutText, data: SHOP_CB.checkout }]);
  }
  buttons.push([{ text: "🍽 Continue Shopping", data: `c:${cafeteria.id}` }]);
  buttons.push([BACK_TO_CAFETERIAS]);
  buttons.push([MAIN_MENU]);
  return { text: out.join("\n"), buttons };
}
