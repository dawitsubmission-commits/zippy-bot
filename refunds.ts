// ZIPPY refunds, customer side. A refund can never be bigger than what is owed for the order.
// The customer says where to send the money (CBE or CBE Birr), confirms, and the admin is told.
// Account details are kept only until the refund is finished (then erased) and are shown only to the admin who pays it.

import { formatEtb } from "./cart";
import { clearState, getState, normalizePhone, setState, validatePersonName, type FlowResult, type User } from "./checkout";
import type { Db } from "./db";
import { REFUND_STATUS_LABEL, getOrder, orderNumber } from "./orders";
import { CB, type Button, type Screen } from "./screens";

type Row = Record<string, unknown>;

export type RefundMethod = "cbe" | "cbe_birr";
export const REFUND_METHOD_LABEL: Record<RefundMethod, string> = { cbe: "CBE", cbe_birr: "CBE Birr" };
export const REFUND_REASON_LABEL: Record<string, string> = {
  cancelled: "Order cancelled",
  unavailable: "Item unavailable",
  changed: "Order changed",
};

export type Refund = {
  id: number;
  orderId: number;
  customerId: number;
  amount: number;
  reason: string;
  status: string;
  method: RefundMethod | null;
  accountName: string | null;
  accountNumber: string | null;
  proofFileId: string | null;
  createdAt: number;
};

function toRefund(r: Row): Refund {
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: Number(r.id),
    orderId: Number(r.order_id),
    customerId: Number(r.customer_id),
    amount: Number(r.amount_santim),
    reason: String(r.reason),
    status: String(r.status),
    method: text(r.method) as RefundMethod | null,
    accountName: text(r.account_name),
    accountNumber: text(r.account_number),
    proofFileId: text(r.proof_file_id),
    createdAt: Number(r.created_at),
  };
}

export async function getRefund(db: Db, id: number): Promise<Refund | null> {
  const r = await db.prepare("SELECT * FROM refunds WHERE id = ?").bind(id).first<Row>();
  return r ? toRefund(r) : null;
}

// ---------- input checks ----------

// CBE: an account number (digits). CBE Birr: the phone number of the wallet.
export function validateAccount(method: RefundMethod, input: string): string | null {
  const t = input.trim();
  if (method === "cbe") {
    const digits = t.replace(/[\s\-]/g, "");
    return /^\d{6,20}$/.test(digits) ? digits : null;
  }
  return normalizePhone(t);
}

// ---------- screens ----------

const MY_ORDERS: Button = { text: "📋 My Orders", data: CB.orders };
const CANCEL: Button = { text: "✖ Cancel", data: "r:cn" };

function methodScreen(orderNo: string, refund: Refund): Screen {
  return {
    text: `💸 Refund for ${orderNo}\n\nAmount: ${formatEtb(refund.amount)}\n\nWhere should we send it?`,
    buttons: [
      [{ text: "🏦 CBE account", data: `r:m:${refund.id}:cbe` }],
      [{ text: "📲 CBE Birr", data: `r:m:${refund.id}:cbb` }],
      [MY_ORDERS],
    ],
  };
}

function numberPrompt(method: RefundMethod): Screen {
  return {
    text: method === "cbe" ? "Type your CBE account number (digits only)." : "Type your CBE Birr phone number.",
    buttons: [[CANCEL]],
  };
}

// ---------- buttons ----------

export async function handleRefundCallback(db: Db, user: User, data: string, now: number): Promise<FlowResult | null> {
  if (!/^r:(o:\d{1,9}|m:\d{1,9}:(cbe|cbb)|ok:\d{1,9}|cn)$/.test(data)) return null;

  if (data === "r:cn") {
    await clearState(db, user.id);
    return { screen: { text: "Okay. You can come back to the refund any time from My Orders.", buttons: [[MY_ORDERS]] } };
  }

  let m = /^r:o:(\d{1,9})$/.exec(data);
  if (m) {
    const order = await getOrder(db, Number(m[1]));
    // Someone else's order is treated like a missing one.
    if (!order || order.customerId !== user.id) return { toast: "That order was not found.", alert: true };
    const row = await db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1").bind(order.id).first<Row>();
    if (!row) return { toast: "There is no refund for that order.", alert: true };
    const refund = toRefund(row);
    if (refund.status !== "awaiting_details") {
      return {
        screen: {
          text: `💸 Refund for ${orderNumber(order.id)}\n\nAmount: ${formatEtb(refund.amount)}\nStatus: ${REFUND_STATUS_LABEL[refund.status] ?? refund.status}`,
          buttons: [[MY_ORDERS]],
        },
      };
    }
    return { screen: methodScreen(orderNumber(order.id), refund) };
  }

  m = /^r:m:(\d{1,9}):(cbe|cbb)$/.exec(data);
  if (m) {
    const refund = await getRefund(db, Number(m[1]));
    if (!refund || refund.customerId !== user.id || refund.status !== "awaiting_details") {
      return { toast: "This refund doesn't need details any more.", alert: true };
    }
    const method: RefundMethod = m[2] === "cbe" ? "cbe" : "cbe_birr";
    await setState(db, user.id, { step: "refund_name", refundId: refund.id, method }, now);
    return {
      screen: {
        text: `${method === "cbe" ? "🏦 CBE account" : "📲 CBE Birr"}\n\nType the name of the account holder, exactly as it appears on the account.`,
        buttons: [[CANCEL]],
      },
    };
  }

  m = /^r:ok:(\d{1,9})$/.exec(data);
  if (m) {
    const state = await getState(db, user.id, now);
    if (state?.step !== "refund_confirm" || state.refundId !== Number(m[1])) {
      return { toast: "That step has expired. Open the refund again from My Orders.", alert: true };
    }
    // Only the customer's own refund that is still waiting for details can be filled in, and only once.
    const res = await db
      .prepare(
        "UPDATE refunds SET method = ?, account_name = ?, account_number = ?, status = 'pending', updated_at = ? " +
          "WHERE id = ? AND customer_id = ? AND status = 'awaiting_details'",
      )
      .bind(state.method, state.name, state.number, now, state.refundId, user.id)
      .run();
    await clearState(db, user.id);
    if (res.meta?.changes !== 1) return { toast: "This refund was already handled.", alert: true };
    const refund = await getRefund(db, state.refundId);
    const order = refund ? await getOrder(db, refund.orderId) : null;
    return {
      screen: {
        text: `✅ Thank you. We have your refund details.\n\nWe'll send ${formatEtb(refund?.amount ?? 0)} to your ${REFUND_METHOD_LABEL[state.method]} and message you here once it has really been sent.`,
        buttons: [[MY_ORDERS]],
      },
      adminNotify: refund
        ? {
            text: `💸 New refund request #${refund.id}\nOrder ${order ? orderNumber(order.id) : refund.orderId} · ${REFUND_REASON_LABEL[refund.reason] ?? refund.reason}\nAmount: ${formatEtb(refund.amount)}\nTo: ${REFUND_METHOD_LABEL[state.method]}`,
            buttons: [[{ text: "Open refund", data: `a:rd:${refund.id}` }]],
          }
        : undefined,
    };
  }
  return null;
}

// ---------- typed text ----------

export async function handleRefundText(db: Db, user: User, text: string, now: number): Promise<FlowResult | null> {
  const state = await getState(db, user.id, now);
  if (!state) return null;

  if (state.step === "refund_name") {
    const checked = validatePersonName(text);
    if (!checked.ok) return { screen: { text: `${checked.error} Try again, or tap Cancel.`, buttons: [[CANCEL]] } };
    await setState(db, user.id, { step: "refund_number", refundId: state.refundId, method: state.method, name: checked.name }, now);
    return { screen: numberPrompt(state.method) };
  }

  if (state.step === "refund_number") {
    const number = validateAccount(state.method, text);
    if (!number) {
      return {
        screen: {
          text: state.method === "cbe" ? "That doesn't look like an account number. Type digits only, or tap Cancel." : "That doesn't look like a phone number. Please check it, or tap Cancel.",
          buttons: [[CANCEL]],
        },
      };
    }
    const refund = await getRefund(db, state.refundId);
    if (!refund || refund.customerId !== user.id || refund.status !== "awaiting_details") {
      await clearState(db, user.id);
      return { screen: { text: "This refund doesn't need details any more.", buttons: [[MY_ORDERS]] } };
    }
    await setState(db, user.id, { step: "refund_confirm", refundId: state.refundId, method: state.method, name: state.name, number }, now);
    return {
      screen: {
        text:
          `Please check:\n\nRefund: ${formatEtb(refund.amount)}\nTo: ${REFUND_METHOD_LABEL[state.method]}\nAccount holder: ${state.name}\n` +
          `${state.method === "cbe" ? "Account number" : "Phone number"}: ${number}\n\nIs this correct?`,
        buttons: [[{ text: "✅ Yes, send my refund here", data: `r:ok:${refund.id}` }], [CANCEL]],
      },
    };
  }

  if (state.step === "refund_confirm") {
    return { screen: { text: "Please tap “Yes” or “Cancel” on the message above.", buttons: [] } };
  }
  return null;
}
