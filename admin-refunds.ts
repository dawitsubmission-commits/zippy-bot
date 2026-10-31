// ZIPPY admin tools for refunds. Only reached for an admin (bot.ts checks the Telegram ID first).
// A refund is marked "Refunded" only after you upload the screenshot of the transfer you really sent and confirm.
// Account details are shown here only, never copied into the audit log, and erased when the refund is finished.

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, clearState, confirmScreen, setState,
  type AdminState, type Notify, type Outcome, type RefundAction,
} from "./admin-state";
import { formatEtb } from "./cart";
import type { Db } from "./db";
import { REFUND_STATUS_LABEL, dateTimeText, getOrder, orderNumber } from "./orders";
import { REFUND_METHOD_LABEL, REFUND_REASON_LABEL, getRefund, type Refund } from "./refunds";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type RefundsResult = { screen?: Screen; toast?: string; alert?: boolean; notify?: Notify[] };

export const isRefundsStep = (step: string): boolean => step === "refund_proof";
export const isRefundsAction = (action: { type: string }): action is RefundAction =>
  action.type === "refund_done" || action.type === "refund_decline";

const BACK_TO_LIST: Button = { text: "⬅ Refund requests", data: "a:rq" };
const OPEN = ["pending", "processing"];

// ---------- screens ----------

async function listScreen(db: Db): Promise<Screen> {
  const { results } = await db
    .prepare("SELECT id, order_id, amount_santim, status FROM refunds WHERE status IN ('pending', 'processing') ORDER BY id")
    .all<Row>();
  const waiting = await db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE status = 'awaiting_details'").first<Row>();
  const n = Number(waiting?.n ?? 0);
  return {
    text:
      `💸 Refund requests\n\n${results.length === 0 ? "Nothing to process right now." : "Oldest first. Tap one to open it."}` +
      (n > 0 ? `\n\n${n} more ${n === 1 ? "is" : "are"} waiting for the customer to give their account details.` : ""),
    buttons: [
      ...results.map((r) => [
        {
          text: `#${Number(r.id)} · ${orderNumber(Number(r.order_id))} · ${formatEtb(Number(r.amount_santim))} · ${REFUND_STATUS_LABEL[String(r.status)] ?? String(r.status)}`,
          data: `a:rd:${Number(r.id)}`,
        },
      ]),
      [{ text: "📦 Manage Orders", data: "a:orders" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function detailScreen(db: Db, r: Refund): Promise<Screen> {
  const order = await getOrder(db, r.orderId);
  const showAccount = OPEN.includes(r.status) && r.method !== null;
  const text = [
    `💸 Refund #${r.id} — ${REFUND_STATUS_LABEL[r.status] ?? r.status}`,
    `Order: ${orderNumber(r.orderId)}${order ? ` (${order.name})` : ""}`,
    `Reason: ${REFUND_REASON_LABEL[r.reason] ?? r.reason}`,
    `Amount to refund: ${formatEtb(r.amount)}`,
    `Requested: ${dateTimeText(r.createdAt)}`,
    "",
    showAccount ? `Send to: ${REFUND_METHOD_LABEL[r.method!]}` : "",
    showAccount ? `Account holder: ${r.accountName ?? "-"}` : "",
    showAccount ? `${r.method === "cbe" ? "Account number" : "Phone number"}: ${r.accountNumber ?? "-"}` : "",
    showAccount ? "" : "",
    r.status === "pending" ? "Tap “Start processing”, send the money, then upload the screenshot of the transfer." : "",
    r.status === "processing" ? "Send the money, then upload the screenshot of the transfer you really made." : "",
    r.status === "refunded" ? "The money was sent and the account details were erased." : "",
  ]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();

  const buttons: Button[][] = [];
  if (r.status === "pending") buttons.push([{ text: "▶ Start processing", data: `a:rp:${r.id}` }]);
  if (r.status === "processing") buttons.push([{ text: "📸 Upload transfer screenshot", data: `a:rs:${r.id}` }]);
  if (OPEN.includes(r.status)) buttons.push([{ text: "❌ Decline", data: `a:rn:${r.id}` }]);
  buttons.push([{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${r.customerId}` }]);
  buttons.push([BACK_TO_LIST]);
  return { text, buttons };
}

// ---------- buttons ----------

export async function handleRefundsCallback(db: Db, adminId: number, data: string, now: number): Promise<RefundsResult | null> {
  if (data === "a:rq") {
    await clearState(db, adminId);
    return { screen: await listScreen(db) };
  }

  let m = /^a:rd:(\d{1,9})$/.exec(data);
  if (m) {
    const r = await getRefund(db, Number(m[1]));
    return r ? { screen: await detailScreen(db, r) } : { screen: await listScreen(db), toast: "That refund was not found." };
  }

  m = /^a:rp:(\d{1,9})$/.exec(data);
  if (m) {
    const id = Number(m[1]);
    const before = await getRefund(db, id);
    if (!before || before.status !== "pending") {
      return { screen: await listScreen(db), toast: "That refund isn't waiting to be started.", alert: true };
    }
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'refund.processing', ?, ? WHERE EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status = 'pending')")
        .bind(now, adminId, `refund:${id}`, JSON.stringify({ amount: before.amount }), id),
      db.prepare("UPDATE refunds SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, id),
    ]);
    const after = await getRefund(db, id);
    if (!after || after.status !== "processing") return { screen: await listScreen(db), toast: "Nothing was changed.", alert: true };
    return {
      screen: await detailScreen(db, after),
      toast: "Marked as processing.",
      notify: [{ chatId: after.customerId, text: `⏳ We're processing your refund of ${formatEtb(after.amount)} for order ${orderNumber(after.orderId)}.` }],
    };
  }

  m = /^a:rs:(\d{1,9})$/.exec(data);
  if (m) {
    const r = await getRefund(db, Number(m[1]));
    if (!r || r.status !== "processing") return { screen: await listScreen(db), toast: "Start processing first.", alert: true };
    await setState(db, adminId, { step: "refund_proof", refundId: r.id }, now);
    return {
      screen: {
        text: `📸 Refund #${r.id}\n\nSend the screenshot of the transfer you made (as a photo). It will be shown to the customer as proof.`,
        buttons: [[{ text: "✖ Cancel", data: "a:cn" }]],
      },
    };
  }

  m = /^a:rn:(\d{1,9})$/.exec(data);
  if (m) {
    const r = await getRefund(db, Number(m[1]));
    if (!r || !OPEN.includes(r.status)) return { screen: await listScreen(db), toast: "That refund can't be declined now.", alert: true };
    await setState(db, adminId, { step: "confirm", action: { type: "refund_decline", refundId: r.id } }, now);
    return { screen: confirmScreen(`Decline refund #${r.id} (${formatEtb(r.amount)})?\n\nThe customer will be told. Their account details will be erased.`) };
  }
  return null;
}

// ---------- the transfer screenshot ----------

// Returns a screen if the admin was waiting to send a screenshot, otherwise null.
export async function handleRefundProof(db: Db, adminId: number, state: AdminState | null, fileId: string, now: number): Promise<Screen | null> {
  if (!state || state.step !== "refund_proof") return null;
  const r = await getRefund(db, state.refundId);
  if (!r || r.status !== "processing") {
    await clearState(db, adminId);
    return { text: "That refund isn't being processed any more.", buttons: [[BACK_TO_LIST]] };
  }
  await setState(db, adminId, { step: "confirm", action: { type: "refund_done", refundId: r.id, proofFileId: fileId } }, now);
  return confirmScreen(
    `Mark refund #${r.id} as SENT?\n\nOnly confirm if you really sent ${formatEtb(r.amount)} to:\n${REFUND_METHOD_LABEL[r.method ?? "cbe"]} · ${r.accountName ?? "-"} · ${r.accountNumber ?? "-"}\n\n` +
      "The customer will be told it is done and will get your screenshot.",
  );
}

export async function handleRefundsText(_db: Db, _adminId: number, state: AdminState): Promise<Screen | null> {
  if (state.step !== "refund_proof") return null;
  return { text: "Please send the transfer screenshot as a photo, or send /cancel.", buttons: [] };
}

// ---------- applying a confirmed change ----------

export async function applyRefundsAction(db: Db, adminId: number, action: RefundAction, now: number): Promise<Outcome> {
  const before = await getRefund(db, action.refundId);
  const list = async () => listScreen(db);

  if (action.type === "refund_done") {
    if (!before || before.status !== "processing") return { ok: false, message: "That refund was already handled. Nothing was changed.", screen: await list() };
    await db.batch([
      // The audit log keeps the amount and method, never the account details.
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'refund.completed', ?, ? WHERE EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status = 'processing')")
        .bind(now, adminId, `refund:${before.id}`, JSON.stringify({ amount: before.amount, method: before.method }), before.id),
      db
        .prepare("UPDATE refunds SET status = 'refunded', proof_file_id = ?, account_name = NULL, account_number = NULL, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(action.proofFileId, now, before.id),
      // A cancelled order whose refunds are all finished becomes "refunded".
      db
        .prepare(
          "UPDATE orders SET payment_status = 'refunded', updated_at = ? WHERE id = ? AND status = 'cancelled' AND payment_status = 'refund_pending' " +
            "AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = orders.id AND r.status IN ('awaiting_details', 'pending', 'processing'))",
        )
        .bind(now, before.orderId),
    ]);
    const after = await getRefund(db, before.id);
    if (!after || after.status !== "refunded") return { ok: false, message: "Nothing was changed.", screen: await list() };
    return {
      ok: true,
      message: `Refund #${after.id} marked as sent.`,
      screen: await detailScreen(db, after),
      notify: [
        {
          chatId: after.customerId,
          text: `✅ Your refund of ${formatEtb(after.amount)} for order ${orderNumber(after.orderId)} has been sent to your ${REFUND_METHOD_LABEL[before.method ?? "cbe"]}. Here is the proof of the transfer.`,
          photoFileId: action.proofFileId,
        },
      ],
    };
  }

  // refund_decline
  if (!before || !OPEN.includes(before.status)) return { ok: false, message: "That refund was already handled. Nothing was changed.", screen: await list() };
  await db.batch([
    db
      .prepare(AUDIT_SQL + "SELECT ?, ?, 'refund.declined', ?, ? WHERE EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status IN ('pending', 'processing'))")
      .bind(now, adminId, `refund:${before.id}`, JSON.stringify({ amount: before.amount }), before.id),
    db
      .prepare("UPDATE refunds SET status = 'declined', account_name = NULL, account_number = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")
      .bind(now, before.id),
  ]);
  const after = await getRefund(db, before.id);
  if (!after || after.status !== "declined") return { ok: false, message: "Nothing was changed.", screen: await list() };
  return {
    ok: true,
    message: `Refund #${after.id} declined.`,
    screen: await list(),
    notify: [
      { chatId: after.customerId, text: `We couldn't process your refund request #${after.id} for order ${orderNumber(after.orderId)}. Please contact ZIPPY about it.` },
    ],
  };
}
