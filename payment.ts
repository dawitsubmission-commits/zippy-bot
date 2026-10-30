// ZIPPY payments (manual): the customer pays outside the bot, then sends the bank reference and a screenshot.
// A screenshot is NOT proof of payment. This file only collects the evidence and puts it "under verification".
// Nothing here confirms an order or marks anything paid; verification by the admin comes in the next step.

import { formatEtb, priceCart } from "./cart";
import {
  clearState, getCustomer, getState, setState, startCheckout, stillAllowed, reviewScreen,
  locationSummary, type FlowResult, type User,
} from "./checkout";
import type { Db } from "./db";
import { etTimeFromEpoch } from "./schedule-text";
import { getOrderingStatus } from "./schedule";
import { CB, type Button, type Screen } from "./screens";
import { currentCartScreen, getFeePerPortion, loadCart } from "./store";

type Row = Record<string, unknown>;

export type Method = "cbe" | "cbe_birr";

// PROVISIONAL: how long a payment attempt stays open after the instructions are shown.
export const SESSION_SECONDS = 30 * 60;

export const METHODS: Record<Method, { label: string; button: string; key: string; code: string }> = {
  cbe: { label: "CBE", button: "🏦 Pay with CBE", key: "payment_instructions_cbe", code: "cbe" },
  cbe_birr: { label: "CBE Birr", button: "📲 Pay with CBE Birr", key: "payment_instructions_cbe_birr", code: "cbb" },
};

const MAIN_MENU: Button = { text: "🏠 Main Menu", data: CB.main };
const CANCEL_PAYMENT: Button = { text: "✖ Cancel payment", data: "p:cn" };

// The instructions are typed by the admin (account name, number, ...). Nothing is ever invented here.
export async function getInstructions(db: Db, method: Method): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(METHODS[method].key).first<{ value: string }>();
  return r && r.value.trim().length > 0 ? r.value : null;
}

// "FT25301ABCDE" -> same, uppercased. Letters, digits and dashes only.
export function validateReference(input: string): string | null {
  const t = input.trim().toUpperCase();
  return /^[A-Z0-9\-]{5,40}$/.test(t) ? t : null;
}

export type Session = {
  id: number;
  customerId: number;
  method: Method;
  status: string;
  subtotal: number;
  fee: number;
  total: number;
  portions: number;
  items: { id: number; name: string; unit: number; qty: number }[];
  name: string;
  location: string;
  createdAt: number;
  expiresAt: number;
  bankReference: string | null;
  submittedAt: number | null;
};

function toSession(r: Row): Session {
  let items: Session["items"] = [];
  try {
    items = JSON.parse(String(r.items_json));
  } catch {
    items = [];
  }
  let location = "";
  try {
    location = locationSummary(JSON.parse(String(r.location_json)));
  } catch {
    location = "(unknown)";
  }
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    method: String(r.method) as Method,
    status: String(r.status),
    subtotal: Number(r.subtotal_santim),
    fee: Number(r.fee_santim),
    total: Number(r.total_santim),
    portions: Number(r.portions),
    items,
    name: String(r.customer_name),
    location,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    bankReference: r.bank_reference === null ? null : String(r.bank_reference),
    submittedAt: r.submitted_at === null ? null : Number(r.submitted_at),
  };
}

export async function getSession(db: Db, id: number): Promise<Session | null> {
  const r = await db.prepare("SELECT * FROM checkout_sessions WHERE id = ?").bind(id).first<Row>();
  return r ? toSession(r) : null;
}

// The customer's payment attempt that is still open (waiting for them, or waiting for the admin).
async function openSession(db: Db, customerId: number, now: number): Promise<Session | null> {
  // An attempt the customer never completed simply runs out.
  await db
    .prepare("UPDATE checkout_sessions SET status = 'expired' WHERE customer_id = ? AND status = 'awaiting_payment' AND expires_at <= ?")
    .bind(customerId, now)
    .run();
  const r = await db
    .prepare("SELECT * FROM checkout_sessions WHERE customer_id = ? AND status IN ('awaiting_payment', 'under_verification')")
    .bind(customerId)
    .first<Row>();
  return r ? toSession(r) : null;
}

// Older payments have a real bank reference. New ones don't, and store a placeholder (NONE-<id>) so the
// database rules keep working. The placeholder is never shown to anyone.
export function displayReference(ref: string | null): string | null {
  return ref && !ref.startsWith("NONE-") ? ref : null;
}

export function itemsText(items: Session["items"]): string {
  return items.map((i) => `${i.qty}× ${i.name}`).join(", ");
}

// ---------- screens ----------

function waitingScreen(s: Session): Screen {
  return {
    text:
      `⏳ Your payment is being checked\n\nAmount: ${formatEtb(s.total)} (${s.method === "cbe" ? "CBE" : "CBE Birr"})\n\n` +
      "Your order is not confirmed yet. We'll message you as soon as we have checked the payment.",
    buttons: [[MAIN_MENU]],
  };
}

async function methodScreen(db: Db, total: number): Promise<Screen> {
  const buttons: Button[][] = [];
  for (const m of Object.keys(METHODS) as Method[]) {
    const ready = (await getInstructions(db, m)) !== null;
    buttons.push([
      ready ? { text: METHODS[m].button, data: `p:${METHODS[m].code}` } : { text: `${METHODS[m].label} — not available yet`, data: "p:na" },
    ]);
  }
  buttons.push([{ text: "💰 ZIPPY Wallet — Coming Soon", data: "p:wal" }]);
  buttons.push([{ text: "⬅ Back to review", data: "k:rv" }], [{ text: "✖ Cancel checkout", data: "k:cn" }]);
  return { text: `💳 How would you like to pay?\n\nTotal: ${formatEtb(total)}`, buttons };
}

function instructionsScreen(s: Session, instructions: string): Screen {
  return {
    text: [
      `${METHODS[s.method].button.slice(0, 2)} Pay with ${METHODS[s.method].label}`,
      "",
      `Amount to pay: ${formatEtb(s.total)}`,
      "",
      instructions,
      "",
      "After you pay, send a screenshot of your receipt here as a photo.",
      `Please finish by ${etTimeFromEpoch(s.expiresAt)}, or this payment attempt will close.`,
    ].join("\n"),
    buttons: [[CANCEL_PAYMENT]],
  };
}

// ---------- locking the price ----------

type Created = { ok: true; session: Session } | { ok: false; result: FlowResult };

async function createSession(db: Db, user: User, method: Method, now: number): Promise<Created> {
  const customer = await getCustomer(db, user.id);
  const cart = await loadCart(db, user.id, now);
  if (!customer || !customer.lastLocation || cart.cafeteriaId === null || cart.lines.length === 0) {
    return { ok: false, result: await startCheckout(db, user, now) };
  }
  const fee = await getFeePerPortion(db);
  const priced = priceCart(cart.lines, fee);
  const items = cart.lines.filter((l) => l.available).map((l) => ({ id: l.itemId, name: l.name, unit: l.unitSantim, qty: l.quantity }));
  const expiresAt = now + SESSION_SECONDS;

  // The old unfinished attempt (if any) is replaced by this one, in a single all-or-nothing step.
  await db.batch([
    db.prepare("UPDATE checkout_sessions SET status = 'cancelled' WHERE customer_id = ? AND status = 'awaiting_payment'").bind(user.id),
    db
      .prepare(
        "INSERT INTO checkout_sessions (customer_id, cafeteria_id, method, status, subtotal_santim, fee_santim, total_santim, portions, items_json, customer_name, location_json, created_at, expires_at) " +
          "VALUES (?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        user.id, cart.cafeteriaId, method, priced.subtotal, priced.fee, priced.total, priced.portions,
        JSON.stringify(items), customer.name, JSON.stringify(customer.lastLocation), now, expiresAt,
      ),
  ]);
  const session = await openSession(db, user.id, now);
  if (!session || session.status !== "awaiting_payment") {
    return { ok: false, result: { toast: "Something went wrong. Please try again.", alert: true } };
  }
  return { ok: true, session };
}

// ---------- buttons ----------

export async function handlePaymentCallback(db: Db, user: User, data: string, now: number): Promise<FlowResult | null> {
  if (!/^(k:(pay|rv)|p:(cbe|cbb|na|wal|cn))$/.test(data)) return null;

  if (data === "p:wal") return { toast: "ZIPPY Wallet is coming soon.", alert: true };
  if (data === "p:na") return { toast: "That payment method isn't available yet.", alert: true };

  if (data === "p:cn") {
    const open = await openSession(db, user.id, now);
    if (open && open.status === "under_verification") {
      return { screen: waitingScreen(open), toast: "This payment is already being checked.", alert: true };
    }
    await db
      .prepare("UPDATE checkout_sessions SET status = 'cancelled' WHERE customer_id = ? AND status = 'awaiting_payment'")
      .bind(user.id)
      .run();
    await clearState(db, user.id);
    const view = await currentCartScreen(db, user.id, now);
    return { screen: view.screen, toast: "Payment cancelled. Your cart is saved." };
  }

  // A payment that is already with the admin is never replaced or duplicated.
  const open = await openSession(db, user.id, now);
  if (open && open.status === "under_verification") {
    return { screen: waitingScreen(open), toast: "You already have a payment being checked.", alert: true };
  }

  const problem = await stillAllowed(db, user, now);
  if (problem) return problem;

  if (data === "k:rv") return reviewScreen(db, user, now);

  const customer = await getCustomer(db, user.id);
  if (!customer || !customer.lastLocation) return startCheckout(db, user, now);

  if (data === "k:pay") {
    const cart = await loadCart(db, user.id, now);
    const fee = await getFeePerPortion(db);
    return { screen: await methodScreen(db, priceCart(cart.lines, fee).total) };
  }

  // p:cbe or p:cbb: lock the price and show the admin's instructions
  const method: Method = data === "p:cbe" ? "cbe" : "cbe_birr";
  const instructions = await getInstructions(db, method);
  if (!instructions) return { toast: "That payment method isn't available yet.", alert: true };
  const created = await createSession(db, user, method, now);
  if (!created.ok) return created.result;
  await setState(db, user.id, { step: "pay_photo", sessionId: created.session.id }, now);
  return { screen: instructionsScreen(created.session, instructions) };
}

// ---------- typed text (the bank reference) ----------

export async function handlePaymentText(db: Db, user: User, _text: string, now: number): Promise<FlowResult | null> {
  const state = await getState(db, user.id, now);
  if (!state || (state.step !== "pay_ref" && state.step !== "pay_photo")) return null;

  const session = await getSession(db, state.sessionId);
  if (!session || session.customerId !== user.id || session.status !== "awaiting_payment" || session.expiresAt <= now) {
    await clearState(db, user.id);
    return { screen: { text: "This payment attempt has closed. Your cart is saved. Start again from your cart.", buttons: [[{ text: "🛒 View Cart", data: "v:cart" }]] } };
  }
  return { screen: { text: "Please send the screenshot of your receipt as a photo (not as text).", buttons: [[CANCEL_PAYMENT]] } };
}

// ---------- the screenshot ----------

export async function handlePaymentPhoto(
  db: Db,
  user: User,
  photo: { fileId: string; uniqueId: string },
  now: number,
): Promise<FlowResult> {
  const state = await getState(db, user.id, now);
  if (!state || (state.step !== "pay_photo" && state.step !== "pay_ref")) {
    return { screen: { text: "Thanks, but we weren't expecting a photo right now. Tap /start to open the ZIPPY menu.", buttons: [] } };
  }
  const session = await getSession(db, state.sessionId);
  if (!session || session.customerId !== user.id || session.status !== "awaiting_payment" || session.expiresAt <= now) {
    await clearState(db, user.id);
    return { screen: { text: "This payment attempt has closed. Your cart is saved. Start again from your cart.", buttons: [[{ text: "🛒 View Cart", data: "v:cart" }]] } };
  }

  // The opening hours apply when the evidence is handed in.
  const status = await getOrderingStatus(db, now);
  if (!status.open) {
    return {
      screen: {
        text: "Ordering has closed, so we can't take this payment for an order right now. Your cart is saved.\n\nIf you already paid, please contact ZIPPY.",
        buttons: [[{ text: "🛒 View Cart", data: "v:cart" }], [MAIN_MENU]],
      },
    };
  }

  // The same screenshot can't back two different payments.
  const reused = await db
    .prepare("SELECT id FROM checkout_sessions WHERE screenshot_unique_id = ? AND id != ?")
    .bind(photo.uniqueId, session.id)
    .first();
  if (reused) {
    return {
      screen: { text: "That screenshot has already been used for another payment. Please send the screenshot of this payment.", buttons: [[CANCEL_PAYMENT]] },
    };
  }

  const res = await db
    .prepare(
      "UPDATE checkout_sessions SET status = 'under_verification', screenshot_file_id = ?, screenshot_unique_id = ?, submitted_at = ?, " +
        "bank_reference = COALESCE(bank_reference, 'NONE-' || id) " +
        "WHERE id = ? AND customer_id = ? AND status = 'awaiting_payment' AND expires_at > ?",
    )
    .bind(photo.fileId, photo.uniqueId, now, session.id, user.id, now)
    .run();
  if (res.meta?.changes !== 1) return { toast: "Something went wrong. Please try again.", alert: true };
  await clearState(db, user.id);

  const submitted = (await getSession(db, session.id)) ?? session;
  const customer = await getCustomer(db, user.id);
  const caption = [
    "💳 New payment to verify",
    `Payment #${submitted.id} · ${METHODS[submitted.method].label}`,
    `Customer: ${submitted.name}`,
    customer?.phone ? `Phone: ${customer.phone}` : "",
    `Amount: ${formatEtb(submitted.total)}`,
    displayReference(submitted.bankReference) ? `Bank reference: ${displayReference(submitted.bankReference)}` : "",
    `Items: ${itemsText(submitted.items)}`,
    `Deliver to: ${submitted.location}`,
    "",
    "Check the REAL account before confirming. A screenshot alone is not proof.",
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .slice(0, 1000);

  return {
    screen: waitingScreen(submitted),
    notify: { fileId: photo.fileId, caption },
  };
}
