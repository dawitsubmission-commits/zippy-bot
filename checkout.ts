// ZIPPY checkout steps, one message at a time: name -> phone (if required) -> delivery location -> review.
// Nothing is charged here and no order is created yet: this ends at the review screen.

import { cartSummaryLines } from "./cart";
import type { Db } from "./db";
import { CB, type Button, type Screen } from "./screens";
import { currentCartScreen, getCafeteria, getFeePerPortion, loadCart } from "./store";

type Row = Record<string, unknown>;

export type User = { id: number; firstName?: string };
export type FlowResult = {
  screen?: Screen;
  toast?: string;
  alert?: boolean;
  askContact?: boolean; // the bot shows Telegram's "Share my phone number" button
  thanks?: string; // a short message sent before the next screen (removes the share button)
  notify?: { fileId: string; caption: string }; // a screenshot to forward to the admin
};

const STATE_SECONDS = 30 * 60; // PROVISIONAL: a half-finished checkout is forgotten after 30 minutes
export const MAX_NAME_LENGTH = 60;

// ---------- the delivery location ----------

export type LocType = "men_new" | "men_old" | "women" | "other_campus" | "other_hawassa";
export type Location = { type: LocType; dorm?: string; floor?: string; detail?: string };

const LOC_LABEL: Record<LocType, string> = {
  men_new: "Men's Dorm — New Block",
  men_old: "Men's Dorm — Old Block",
  women: "Women's Dorm — Entrance / Agreed Meeting Point",
  other_campus: "Other Campus Location",
  other_hawassa: "Another Location in Hawassa",
};

export function locationSummary(loc: Location): string {
  if (loc.type === "men_new" || loc.type === "men_old") {
    const floor = loc.floor === "Ground" ? "Ground floor" : `Floor ${loc.floor}`;
    return `${LOC_LABEL[loc.type]}, Dorm ${loc.dorm}, ${floor}`;
  }
  return `${LOC_LABEL[loc.type]}: ${loc.detail}`;
}

function parseLocation(raw: unknown): Location | null {
  try {
    const l = JSON.parse(String(raw)) as Location;
    if (!l || typeof l !== "object" || !(l.type in LOC_LABEL)) return null;
    if (l.type === "men_new" || l.type === "men_old") {
      return typeof l.dorm === "string" && typeof l.floor === "string" ? { type: l.type, dorm: l.dorm, floor: l.floor } : null;
    }
    return typeof l.detail === "string" ? { type: l.type, detail: l.detail } : null;
  } catch {
    return null;
  }
}

// ---------- input checks ----------

const oneLine = (t: string) => !/[\u0000-\u001F\u007F\u2028\u2029]/.test(t);

export function validatePersonName(input: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.trim();
  if (name.length === 0) return { ok: false, error: "Please type your name." };
  if (!oneLine(name)) return { ok: false, error: "Your name must be on one line." };
  if (name.startsWith("/")) return { ok: false, error: "Your name can't start with /." };
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false, error: `Please use at most ${MAX_NAME_LENGTH} characters.` };
  return { ok: true, name };
}

export function validateDorm(input: string): string | null {
  const dorm = input.trim();
  return /^[\p{L}\p{N}\-\/ ]{1,10}$/u.test(dorm) && /[\p{L}\p{N}]/u.test(dorm) ? dorm : null;
}

// "3" -> "3"; "ground" / "g" / "0" -> "Ground"; anything else -> null
export function validateFloor(input: string): string | null {
  const t = input.trim().toLowerCase();
  if (t === "ground" || t === "g" || t === "0" || t === "ground floor") return "Ground";
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 99 ? String(n) : null;
}

export function validateDetail(input: string, max: number): string | null {
  const t = input.trim();
  return t.length >= 2 && [...t].length <= max && oneLine(t) && !t.startsWith("/") ? t : null;
}

// A phone number as Telegram shares it, e.g. "251911223344" or "+251 91 122 3344".
export function normalizePhone(input: string): string | null {
  const t = input.replace(/[\s\-()]/g, "");
  return /^\+?\d{7,15}$/.test(t) ? (t.startsWith("+") ? t : `+${t}`) : null;
}

// ---------- storage ----------

type CState =
  | { step: "name" }
  | { step: "phone" }
  | { step: "dorm"; type: "men_new" | "men_old" }
  | { step: "floor"; type: "men_new" | "men_old"; dorm: string }
  | { step: "detail"; type: "women" | "other_campus" | "other_hawassa" }
  | { step: "loc_confirm"; loc: Location }
  | { step: "pay_ref"; sessionId: number }
  | { step: "pay_photo"; sessionId: number };

export type { CState };

const CSTEPS = ["name", "phone", "dorm", "floor", "detail", "loc_confirm", "pay_ref", "pay_photo"];

export async function getState(db: Db, id: number, now: number): Promise<CState | null> {
  const row = await db.prepare("SELECT data, updated_at FROM customer_state WHERE telegram_user_id = ?").bind(id).first<Row>();
  if (!row) return null;
  if (Number(row.updated_at) < now - STATE_SECONDS) {
    await clearState(db, id);
    return null;
  }
  try {
    const s = JSON.parse(String(row.data)) as CState;
    if (s && CSTEPS.includes(s.step)) return s;
  } catch {
    // fall through
  }
  await clearState(db, id);
  return null;
}

export async function setState(db: Db, id: number, state: CState, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO customer_state (telegram_user_id, data, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (telegram_user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
    .bind(id, JSON.stringify(state), now)
    .run();
}

export async function clearState(db: Db, id: number): Promise<void> {
  await db.prepare("DELETE FROM customer_state WHERE telegram_user_id = ?").bind(id).run();
}

export type Customer = { id: number; name: string; phone: string | null; phoneVerified: boolean; lastLocation: Location | null };

export async function getCustomer(db: Db, id: number): Promise<Customer | null> {
  const r = await db
    .prepare("SELECT telegram_user_id, name, phone, phone_verified, last_location FROM customers WHERE telegram_user_id = ?")
    .bind(id)
    .first<Row>();
  if (!r) return null;
  return {
    id: Number(r.telegram_user_id),
    name: String(r.name),
    phone: r.phone === null ? null : String(r.phone),
    phoneVerified: Number(r.phone_verified) === 1,
    lastLocation: r.last_location === null ? null : parseLocation(r.last_location),
  };
}

async function phoneRequired(db: Db): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'require_phone'").first<{ value: string }>();
  return r?.value !== "0"; // if the setting is missing, play safe and ask
}

async function saveName(db: Db, id: number, name: string, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO customers (telegram_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (telegram_user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
    )
    .bind(id, name, now, now)
    .run();
}

// ---------- screens ----------

const CANCEL: Button = { text: "✖ Cancel checkout", data: "k:cn" };
const BACK_TO_CART: Button = { text: "⬅ Back to cart", data: "v:cart" };
const MAIN_MENU: Button = { text: "🏠 Main Menu", data: CB.main };

function prompt(text: string, extra: Button[][] = []): Screen {
  return { text, buttons: [...extra, [CANCEL]] };
}

function namePrompt(user: User): Screen {
  const extra: Button[][] = user.firstName && validatePersonName(user.firstName).ok
    ? [[{ text: `Use "${user.firstName.trim()}"`, data: "n:use" }]]
    : [];
  return prompt("👤 Your name\n\nWhat name should we call when we deliver your order? Type it, or tap the button.", extra);
}

const PHONE_PROMPT: Screen = prompt(
  "📱 Your phone number\n\nWe need a number to reach you if there's a problem with delivery. Tap the button below to share your Telegram number.\n\nWe only keep it to deliver your orders.",
);

function locationChoiceScreen(last: Location | null): Screen {
  const buttons: Button[][] = [];
  if (last) buttons.push([{ text: `📍 Use my last location`, data: "l:last" }]);
  buttons.push(
    [{ text: LOC_LABEL.men_new, data: "l:mn" }],
    [{ text: LOC_LABEL.men_old, data: "l:mo" }],
    [{ text: LOC_LABEL.women, data: "l:w" }],
    [{ text: LOC_LABEL.other_campus, data: "l:oc" }],
    [{ text: LOC_LABEL.other_hawassa, data: "l:oh" }],
    [BACK_TO_CART],
  );
  return {
    text: `📍 Where should we deliver?${last ? `\n\nLast time: ${locationSummary(last)}` : ""}`,
    buttons,
  };
}

function confirmLocationScreen(loc: Location): Screen {
  return {
    text: `📍 Delivery location\n\n${locationSummary(loc)}\n\nIs this correct?`,
    buttons: [
      [{ text: "✅ Yes, deliver here", data: "l:ok" }],
      [{ text: "✏️ Change", data: "l:chg" }],
      [CANCEL],
    ],
  };
}

export async function reviewScreen(db: Db, user: User, now: number): Promise<FlowResult> {
  const view = await currentCartScreen(db, user.id, now);
  if (!view.orderingOpen) return { screen: view.screen, toast: `${view.statusLine}\nYour cart is saved.`, alert: true };
  if (view.hasUnavailable) return { screen: view.screen, toast: "Remove the unavailable items first.", alert: true };
  if (view.lineCount === 0) return { screen: view.screen };

  const cart = await loadCart(db, user.id, now);
  const customer = await getCustomer(db, user.id);
  const cafeteria = cart.cafeteriaId === null ? null : await getCafeteria(db, cart.cafeteriaId);
  if (!customer || !customer.lastLocation || !cafeteria) return { screen: locationChoiceScreen(customer?.lastLocation ?? null) };

  // The totals are calculated here on the server from the current menu prices, every time.
  const fee = await getFeePerPortion(db);
  const text = [
    `🧾 Review your order — ${cafeteria.name}`,
    "",
    ...cartSummaryLines(cart.lines, fee),
    "",
    `📍 Deliver to: ${locationSummary(customer.lastLocation)}`,
    `👤 Name: ${customer.name}`,
  ].join("\n");
  return {
    screen: {
      text,
      buttons: [
        [{ text: "➡ Continue to payment", data: "k:pay" }],
        [{ text: "✏️ Change location", data: "l:chg" }],
        [BACK_TO_CART],
        [MAIN_MENU],
      ],
    },
  };
}

// ---------- the steps ----------

// Where to go next once the customer's details are complete enough.
async function nextStep(db: Db, user: User, now: number): Promise<FlowResult> {
  const customer = await getCustomer(db, user.id);
  if (!customer) {
    await setState(db, user.id, { step: "name" }, now);
    return { screen: namePrompt(user) };
  }
  if ((await phoneRequired(db)) && !customer.phoneVerified) {
    await setState(db, user.id, { step: "phone" }, now);
    return { screen: PHONE_PROMPT, askContact: true };
  }
  await clearState(db, user.id);
  return { screen: locationChoiceScreen(customer.lastLocation) };
}

// Called when the Checkout button is tapped and the shop code has already checked the cart and the hours.
export async function startCheckout(db: Db, user: User, now: number): Promise<FlowResult> {
  return nextStep(db, user, now);
}

// Checks again that the cart and the opening hours still allow checkout. Returns a problem or null.
export async function stillAllowed(db: Db, user: User, now: number): Promise<FlowResult | null> {
  const view = await currentCartScreen(db, user.id, now);
  if (!view.orderingOpen) return { screen: view.screen, toast: `${view.statusLine}\nYour cart is saved.`, alert: true };
  if (view.hasUnavailable) return { screen: view.screen, toast: "Remove the unavailable items first.", alert: true };
  if (view.lineCount === 0) return { screen: view.screen, toast: "Your cart is empty." };
  return null;
}

const EXPIRED: FlowResult = { toast: "That step has expired. Please start again from your cart." };

export async function handleCheckoutCallback(db: Db, user: User, data: string, now: number): Promise<FlowResult | null> {
  if (!/^(n:use|l:(mn|mo|w|oc|oh|last|fg|ok|chg)|k:cn)$/.test(data)) return null;

  if (data === "k:cn") {
    await clearState(db, user.id);
    const view = await currentCartScreen(db, user.id, now);
    return { screen: view.screen, toast: "Checkout cancelled. Your cart is saved." };
  }

  const problem = await stillAllowed(db, user, now);
  if (problem) {
    await clearState(db, user.id);
    return problem;
  }

  if (data === "n:use") {
    const state = await getState(db, user.id, now);
    const checked = validatePersonName(user.firstName ?? "");
    if (state?.step !== "name" || !checked.ok) return EXPIRED;
    await saveName(db, user.id, checked.name, now);
    return nextStep(db, user, now);
  }

  if (data === "l:chg") {
    const customer = await getCustomer(db, user.id);
    if (!customer) return nextStep(db, user, now);
    await clearState(db, user.id);
    return { screen: locationChoiceScreen(customer.lastLocation) };
  }

  // Everything below needs a saved name (and a verified phone when that is required).
  const customer = await getCustomer(db, user.id);
  if (!customer || ((await phoneRequired(db)) && !customer.phoneVerified)) return nextStep(db, user, now);

  switch (data) {
    case "l:mn":
    case "l:mo": {
      await setState(db, user.id, { step: "dorm", type: data === "l:mn" ? "men_new" : "men_old" }, now);
      return { screen: prompt(`🏢 ${data === "l:mn" ? LOC_LABEL.men_new : LOC_LABEL.men_old}\n\nType your dorm number.`) };
    }
    case "l:w":
      await setState(db, user.id, { step: "detail", type: "women" }, now);
      return {
        screen: prompt(`🏢 ${LOC_LABEL.women}\n\nType the entrance or the meeting point you agree on (for example the name of the entrance).\nDelivery to rooms isn't assumed.`),
      };
    case "l:oc":
      await setState(db, user.id, { step: "detail", type: "other_campus" }, now);
      return { screen: prompt("📍 Other campus location\n\nDescribe where on campus we should deliver, so we can find you.") };
    case "l:oh":
      await setState(db, user.id, { step: "detail", type: "other_hawassa" }, now);
      return { screen: prompt("📍 Another location in Hawassa\n\nDescribe the place (area, building, landmark), so we can find you.") };
    case "l:last": {
      if (!customer.lastLocation) return { screen: locationChoiceScreen(null), toast: "You don't have a saved location yet." };
      await setState(db, user.id, { step: "loc_confirm", loc: customer.lastLocation }, now);
      return { screen: confirmLocationScreen(customer.lastLocation) };
    }
    case "l:fg": {
      const state = await getState(db, user.id, now);
      if (state?.step !== "floor") return EXPIRED;
      const loc: Location = { type: state.type, dorm: state.dorm, floor: "Ground" };
      await setState(db, user.id, { step: "loc_confirm", loc }, now);
      return { screen: confirmLocationScreen(loc) };
    }
    case "l:ok": {
      const state = await getState(db, user.id, now);
      if (state?.step !== "loc_confirm") return EXPIRED;
      await db
        .prepare("UPDATE customers SET last_location = ?, updated_at = ? WHERE telegram_user_id = ?")
        .bind(JSON.stringify(state.loc), now, user.id)
        .run();
      await clearState(db, user.id);
      return reviewScreen(db, user, now);
    }
  }
  return null;
}

// Text typed by a customer in the middle of checkout. Returns null if they are not in a checkout step.
export async function handleCheckoutText(db: Db, user: User, text: string, now: number): Promise<FlowResult | null> {
  const state = await getState(db, user.id, now);
  if (!state) return null;
  if (state.step === "pay_ref" || state.step === "pay_photo") return null; // handled by payment.ts

  const problem = await stillAllowed(db, user, now);
  if (problem) {
    await clearState(db, user.id);
    return { screen: { text: `${problem.toast ?? "Checkout isn't available right now."}`, buttons: [[{ text: "🛒 View Cart", data: "v:cart" }]] } };
  }

  switch (state.step) {
    case "name": {
      const checked = validatePersonName(text);
      if (!checked.ok) return { screen: prompt(`${checked.error} Try again, or tap Cancel.`) };
      await saveName(db, user.id, checked.name, now);
      return nextStep(db, user, now);
    }
    case "phone":
      return { screen: prompt("Please tap the “Share my phone number” button below. You can't type it in, so we know it's really yours."), askContact: true };
    case "dorm": {
      const dorm = validateDorm(text);
      if (!dorm) return { screen: prompt("Please type just your dorm number (up to 10 letters or numbers), or tap Cancel.") };
      await setState(db, user.id, { step: "floor", type: state.type, dorm }, now);
      return {
        screen: prompt(`Dorm ${dorm}.\n\nWhich floor? Type the floor number (for example 3), or tap Ground floor.`, [
          [{ text: "Ground floor", data: "l:fg" }],
        ]),
      };
    }
    case "floor": {
      const floor = validateFloor(text);
      if (!floor) {
        return {
          screen: prompt("Please type the floor as a number from 1 to 99, or tap Ground floor.", [[{ text: "Ground floor", data: "l:fg" }]]),
        };
      }
      const loc: Location = { type: state.type, dorm: state.dorm, floor };
      await setState(db, user.id, { step: "loc_confirm", loc }, now);
      return { screen: confirmLocationScreen(loc) };
    }
    case "detail": {
      const max = state.type === "women" ? 80 : 120;
      const detail = validateDetail(text, max);
      if (!detail) return { screen: prompt(`Please describe the place in one line of at most ${max} characters, or tap Cancel.`) };
      const loc: Location = { type: state.type, detail };
      await setState(db, user.id, { step: "loc_confirm", loc }, now);
      return { screen: confirmLocationScreen(loc) };
    }
    case "loc_confirm":
      return { screen: confirmLocationScreen(state.loc), toast: undefined };
  }
}

// The customer tapped "Share my phone number". Only a contact that belongs to the sender counts.
export async function handleContact(
  db: Db,
  user: User,
  contact: { phone_number: string; user_id?: number },
  now: number,
): Promise<FlowResult> {
  const state = await getState(db, user.id, now);
  if (state?.step !== "phone") {
    return { screen: { text: "Thanks, but we didn't ask for a phone number right now. Tap /start to open the ZIPPY menu.", buttons: [] } };
  }
  if (contact.user_id !== user.id) {
    return {
      screen: prompt("That contact isn't yours. Please tap the “Share my phone number” button to share your own number."),
      askContact: true,
    };
  }
  const phone = normalizePhone(contact.phone_number);
  if (!phone) return { screen: prompt("We couldn't read that number. Please try the button again."), askContact: true };
  await db
    .prepare("UPDATE customers SET phone = ?, phone_verified = 1, updated_at = ? WHERE telegram_user_id = ?")
    .bind(phone, now, user.id)
    .run();
  const next = await nextStep(db, user, now);
  return { ...next, thanks: "✅ Thanks, your number is saved." };
}
