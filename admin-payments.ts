// ZIPPY admin tools for payments. Only reached for an admin (bot.ts checks the Telegram ID first).
// - Payment instructions: the admin types the text customers see (account name, number, ...). Never invented.
//   The text is stored in settings and is NOT copied into the audit log (only its length is).
// - Payment Verification: a read-only list of payments waiting to be checked. Confirming/rejecting comes next.

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, CANCEL, clearState, confirmScreen, setState,
  type AdminState, type Outcome, type PaymentAction,
} from "./admin-state";
import { formatEtb } from "./cart";
import type { Db } from "./db";
import { METHODS, displayReference, getSession, itemsText, type Method } from "./payment";
import { etTimeFromEpoch } from "./schedule-text";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type PaymentsResult = { screen?: Screen; toast?: string; alert?: boolean };

const CODE_TO_METHOD: Record<string, Method> = { cbe: "cbe", cbb: "cbe_birr" };
const MAX_INSTRUCTIONS = 800;
const MIN_INSTRUCTIONS = 10;

export const isPaymentsStep = (step: string): boolean => step === "pay_instr";
export const isPaymentsAction = (action: { type: string }): action is PaymentAction =>
  action.type === "pay_instr" || action.type === "pay_instr_clear";

// Instructions may have several lines. Other control characters are not allowed.
export function validateInstructions(input: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = input.replace(/\r\n/g, "\n").trim();
  if ([...text].length < MIN_INSTRUCTIONS) return { ok: false, error: `Please write at least ${MIN_INSTRUCTIONS} characters.` };
  if ([...text].length > MAX_INSTRUCTIONS) return { ok: false, error: `Please keep it under ${MAX_INSTRUCTIONS} characters.` };
  if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return { ok: false, error: "That text has characters that aren't allowed." };
  return { ok: true, text };
}

const BACK_TO_PAYMENTS: Button = { text: "⬅ Payment Verification", data: "a:pay" };
const BACK_TO_SETTINGS: Button = { text: "⬅ Bot Settings", data: "a:settings" };

async function instructionsStatus(db: Db, method: Method): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(METHODS[method].key).first<{ value: string }>();
  return Boolean(r && r.value.trim().length > 0);
}

// ---------- screens ----------

async function instructionsScreen(db: Db): Promise<Screen> {
  const cbe = await instructionsStatus(db, "cbe");
  const cbb = await instructionsStatus(db, "cbe_birr");
  return {
    text:
      "💳 Payment instructions\n\nThese are the words customers see when they choose to pay.\n\n" +
      `CBE: ${cbe ? "Set ✅" : "Not set ❌ (customers can't pay with it)"}\n` +
      `CBE Birr: ${cbb ? "Set ✅" : "Not set ❌ (customers can't pay with it)"}`,
    buttons: [
      [{ text: "✏️ Set CBE instructions", data: "a:pi:cbe" }],
      [{ text: "✏️ Set CBE Birr instructions", data: "a:pi:cbb" }],
      [BACK_TO_SETTINGS],
    ],
  };
}

export async function overviewScreen(db: Db): Promise<Screen> {
  const { results } = await db
    .prepare("SELECT method, COUNT(*) AS n FROM checkout_sessions WHERE status = 'under_verification' GROUP BY method")
    .all<Row>();
  const count = (m: Method) => Number(results.find((r) => String(r.method) === m)?.n ?? 0);
  return {
    text:
      `💳 Payment Verification\n\nWaiting to be checked:\nCBE: ${count("cbe")}\nCBE Birr: ${count("cbe_birr")}\n\n` +
      "Open one, check your REAL account, then confirm or reject it.",
    buttons: [
      [{ text: `📋 CBE Payments (${count("cbe")})`, data: "a:pl:cbe" }],
      [{ text: `📋 CBE Birr Payments (${count("cbe_birr")})`, data: "a:pl:cbb" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function listScreen(db: Db, method: Method): Promise<Screen> {
  const { results } = await db
    .prepare("SELECT id, customer_name, total_santim FROM checkout_sessions WHERE method = ? AND status = 'under_verification' ORDER BY submitted_at, id")
    .bind(method)
    .all<Row>();
  return {
    text: `📋 ${METHODS[method].label} payments waiting to be checked\n\n${results.length === 0 ? "Nothing is waiting." : "Tap one to see the details."}`,
    buttons: [
      ...results.map((r) => [
        { text: `#${Number(r.id)} — ${formatEtb(Number(r.total_santim))} — ${String(r.customer_name)}`, data: `a:ps:${Number(r.id)}` },
      ]),
      [BACK_TO_PAYMENTS],
    ],
  };
}

async function detailScreen(db: Db, id: number): Promise<Screen | null> {
  const s = await getSession(db, id);
  if (!s) return null;
  const c = await db.prepare("SELECT phone FROM customers WHERE telegram_user_id = ?").bind(s.customerId).first<{ phone: string | null }>();
  const text = [
    `💳 Payment #${s.id} · ${METHODS[s.method].label}`,
    `Status: ${s.status.replaceAll("_", " ")}`,
    "",
    `Customer: ${s.name}`,
    c?.phone ? `Phone: ${c.phone}` : "Phone: not shared",
    `Deliver to: ${s.location}`,
    "",
    `Items: ${itemsText(s.items)}`,
    `Food subtotal: ${formatEtb(s.subtotal)}`,
    `Delivery fee: ${formatEtb(s.fee)}`,
    `Total expected: ${formatEtb(s.total)}`,
    "",
    displayReference(s.bankReference) ? `Bank reference: ${displayReference(s.bankReference)}` : "",
    s.submittedAt ? `Submitted: ${etTimeFromEpoch(s.submittedAt)}` : "",
    "",
    "The screenshot was sent to you when it arrived. Check the REAL account before anything is confirmed.",
  ]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");
  const buttons: Button[][] = [];
  if (s.status === "under_verification") {
    buttons.push([{ text: "✅ Confirm payment", data: `a:pv:${s.id}` }]);
    buttons.push([{ text: "❌ Reject payment", data: `a:px:${s.id}` }]);
    buttons.push([{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${s.customerId}` }]);
  }
  buttons.push([{ text: "⬅ Back to the list", data: `a:pl:${METHODS[s.method].code}` }]);
  return { text, buttons };
}

// ---------- buttons ----------

export async function handlePaymentsCallback(db: Db, adminId: number, data: string, now: number): Promise<PaymentsResult | null> {
  if (data === "a:pay") {
    await clearState(db, adminId);
    return { screen: await overviewScreen(db) };
  }
  if (data === "a:pi") {
    await clearState(db, adminId);
    return { screen: await instructionsScreen(db) };
  }

  let m = /^a:pl:(cbe|cbb)$/.exec(data);
  if (m) return { screen: await listScreen(db, CODE_TO_METHOD[m[1]]) };

  m = /^a:ps:(\d{1,9})$/.exec(data);
  if (m) {
    const screen = await detailScreen(db, Number(m[1]));
    return screen ? { screen } : { screen: await overviewScreen(db), toast: "That payment was not found." };
  }

  m = /^a:pi:(cbe|cbb)$/.exec(data);
  if (m) {
    const method = CODE_TO_METHOD[m[1]];
    await setState(db, adminId, { step: "pay_instr", method }, now);
    return {
      screen: {
        text:
          `✏️ ${METHODS[method].label} payment instructions\n\nType the instructions exactly as customers should see them: the account holder's name, the account number, and anything they must include. ` +
          `Up to ${MAX_INSTRUCTIONS} characters, any number of lines.\n\nThis text is shown to customers. It is not written to the audit log.`,
        buttons: [[{ text: "🗑 Remove the current instructions", data: `a:pic:${m[1]}` }], [CANCEL]],
      },
    };
  }

  m = /^a:pic:(cbe|cbb)$/.exec(data);
  if (m) {
    const method = CODE_TO_METHOD[m[1]];
    if (!(await instructionsStatus(db, method))) return { screen: await instructionsScreen(db), toast: "There are no instructions to remove." };
    await setState(db, adminId, { step: "confirm", action: { type: "pay_instr_clear", method } }, now);
    return {
      screen: confirmScreen(`Remove the ${METHODS[method].label} instructions?\n\nCustomers won't be able to pay with ${METHODS[method].label} until you add new ones.`),
    };
  }
  return null;
}

// ---------- text typed by the admin ----------

export async function handlePaymentsText(db: Db, adminId: number, state: AdminState, text: string, now: number): Promise<Screen | null> {
  if (state.step !== "pay_instr") return null;
  const checked = validateInstructions(text);
  if (!checked.ok) return { text: `${checked.error} Try again, or tap Cancel.`, buttons: [[CANCEL]] };
  await setState(db, adminId, { step: "confirm", action: { type: "pay_instr", method: state.method, text: checked.text } }, now);
  return confirmScreen(`Show customers this when they pay with ${METHODS[state.method].label}?\n\n———\n${checked.text}\n———`);
}

// ---------- applying a confirmed change ----------

export async function applyPaymentsAction(db: Db, adminId: number, action: PaymentAction, now: number): Promise<Outcome> {
  if (action.type === "pay_instr") {
    await db.batch([
      db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(METHODS[action.method].key, action.text),
      // Only the method and the length go into the audit log, never the account details.
      db
        .prepare(AUDIT_SQL + "VALUES (?, ?, 'settings.payment_instructions', 'settings', ?)")
        .bind(now, adminId, JSON.stringify({ method: action.method, length: [...action.text].length })),
    ]);
    return { ok: true, message: `${METHODS[action.method].label} instructions saved.`, screen: await instructionsScreen(db) };
  }
  await db.batch([
    db
      .prepare(AUDIT_SQL + "SELECT ?, ?, 'settings.payment_instructions_removed', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = ?)")
      .bind(now, adminId, JSON.stringify({ method: action.method }), METHODS[action.method].key),
    db.prepare("DELETE FROM settings WHERE key = ?").bind(METHODS[action.method].key),
  ]);
  return { ok: true, message: `${METHODS[action.method].label} instructions removed.`, screen: await instructionsScreen(db) };
}
