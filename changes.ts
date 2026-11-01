// ZIPPY order changes, customer side. When the admin marks an item of a paid order as unavailable, the customer
// can: change the order (replacement item), request a refund for the missing item, or contact the admin.
// The server recalculates every total itself. The delivery fee follows the NEW number of portions, so it is never charged twice.
//   new total higher  -> the customer pays the DIFFERENCE (receipt photo, checked by the admin)
//   new total lower   -> the difference is owed back (a refund)
//   same              -> nothing to pay

import { MAX_QTY_PER_ITEM, formatEtb } from "./cart";
import { setState, type FlowResult, type User } from "./checkout";
import type { Db } from "./db";
import { getOrder, orderNumber, type Order, type OrderItem } from "./orders";
import { METHODS, createTopupSession, getInstructions, instructionsScreen, openSession, type Method } from "./payment";
import { CB, type Button, type Screen } from "./screens";
import { listMenu } from "./store";

const MY_ORDERS: Button = { text: "📋 My Orders", data: CB.orders };

export type Repriced = { items: OrderItem[]; subtotal: number; fee: number; portions: number; total: number };

// The order after removing some items and (optionally) adding a replacement. Null if it can't be priced safely.
export function reprice(order: Order, removeIds: number[], add?: OrderItem): Repriced | null {
  const perPortion = order.portions > 0 ? order.fee / order.portions : 0;
  if (!Number.isInteger(perPortion)) return null;
  const items: OrderItem[] = order.items.filter((i) => !removeIds.includes(i.id)).map((i) => ({ ...i }));
  if (add) {
    const existing = items.find((i) => i.id === add.id);
    if (existing) {
      existing.qty += add.qty;
      if (existing.qty > MAX_QTY_PER_ITEM) return null;
    } else {
      items.push({ ...add });
    }
  }
  const portions = items.reduce((n, i) => n + i.qty, 0);
  const subtotal = items.reduce((n, i) => n + i.unit * i.qty, 0);
  const fee = portions * perPortion;
  return { items, subtotal, fee, portions, total: subtotal + fee };
}

const itemLines = (items: OrderItem[]) => items.map((i) => `${i.qty} × ${i.name} — ${formatEtb(i.unit * i.qty)}`);

// ---------- loading and checking ----------

type Flagged = { order: Order; missing: OrderItem[] } | { error: FlowResult };

async function loadFlagged(db: Db, user: User, orderId: number): Promise<Flagged> {
  const order = await getOrder(db, orderId);
  // Someone else's order is treated like a missing one.
  if (!order || order.customerId !== user.id) return { error: { toast: "That order was not found.", alert: true } };
  if (!order.needsAction || order.status === "completed" || order.status === "cancelled") {
    return { error: { toast: "Nothing needs your decision on this order any more.", alert: true } };
  }
  const missing = order.items.filter((i) => order.missingIds.includes(i.id));
  if (missing.length === 0) return { error: { toast: "Nothing needs your decision on this order any more.", alert: true } };
  return { order, missing };
}

// ---------- screens ----------

function optionsScreen(order: Order, missing: OrderItem[]): Screen {
  return {
    text: `⚠️ Order ${orderNumber(order.id)}\n\nSorry, ${missing.map((m) => m.name).join(", ")} isn't available.\n\nWhat would you like to do?`,
    buttons: [
      [{ text: "✏️ Change My Order", data: `chr:${order.id}` }],
      [{ text: "💸 Request Refund", data: `chu:${order.id}` }],
      [{ text: "📞 Contact Admin", data: `chh:${order.id}` }],
    ],
  };
}

function summaryText(order: Order, re: Repriced): string {
  const delta = re.total - order.total;
  return [
    ...itemLines(re.items),
    "",
    `Food subtotal: ${formatEtb(re.subtotal)}`,
    `Delivery fee (${re.portions} portion${re.portions === 1 ? "" : "s"}): ${formatEtb(re.fee)}`,
    `New total: ${formatEtb(re.total)}`,
    `Your order was: ${formatEtb(order.total)}`,
    "",
    delta > 0 ? `➡ You need to pay ${formatEtb(delta)} more.` : delta < 0 ? `➡ We owe you ${formatEtb(-delta)}.` : "➡ Nothing more to pay.",
  ].join("\n");
}

// ---------- applying a change (all or nothing, guarded on the order still being as the customer saw it) ----------

async function applyChange(db: Db, order: Order, re: Repriced, reason: "unavailable" | "changed", now: number): Promise<boolean> {
  const refund = order.total - re.total; // zero or more here
  if (re.items.length === 0) {
    // Nothing is left: the order is cancelled and the whole remaining value is owed back.
    await db.batch([
      db
        .prepare(
          "INSERT INTO refunds (order_id, customer_id, amount_santim, reason, status, created_at, updated_at) " +
            "SELECT o.id, o.customer_id, o.total_santim, ?, 'awaiting_details', ?, ? FROM orders o " +
            "WHERE o.id = ? AND o.customer_id = ? AND o.needs_action = 1 AND o.items_json = ? AND o.total_santim > 0",
        )
        .bind(reason, now, now, order.id, order.customerId, order.itemsJson),
      db
        .prepare(
          "UPDATE orders SET status = 'cancelled', payment_status = 'refund_pending', needs_action = 0, missing_json = NULL, updated_at = ? " +
            "WHERE id = ? AND customer_id = ? AND needs_action = 1 AND items_json = ?",
        )
        .bind(now, order.id, order.customerId, order.itemsJson),
      db
        .prepare(
          "INSERT INTO order_status_history (order_id, from_status, to_status, actor_telegram_id, at) " +
            "SELECT o.id, ?, 'cancelled', ?, ? FROM orders o WHERE o.id = ? AND o.status = 'cancelled' " +
            "AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'cancelled')",
        )
        .bind(order.status, order.customerId, now, order.id),
    ]);
  } else {
    await db.batch([
      ...(refund > 0
        ? [
            db
              .prepare(
                "INSERT INTO refunds (order_id, customer_id, amount_santim, reason, status, created_at, updated_at) " +
                  "SELECT o.id, o.customer_id, ?, ?, 'awaiting_details', ?, ? FROM orders o " +
                  "WHERE o.id = ? AND o.customer_id = ? AND o.needs_action = 1 AND o.items_json = ?",
              )
              .bind(refund, reason, now, now, order.id, order.customerId, order.itemsJson),
          ]
        : []),
      db
        .prepare(
          "UPDATE orders SET items_json = ?, subtotal_santim = ?, fee_santim = ?, total_santim = ?, portions = ?, needs_action = 0, missing_json = NULL, updated_at = ? " +
            "WHERE id = ? AND customer_id = ? AND needs_action = 1 AND items_json = ?",
        )
        .bind(JSON.stringify(re.items), re.subtotal, re.fee, re.total, re.portions, now, order.id, order.customerId, order.itemsJson),
    ]);
  }
  const after = await getOrder(db, order.id);
  return !!after && !after.needsAction;
}

function doneResult(order: Order, re: Repriced, refundOwed: number): FlowResult {
  const cancelled = re.items.length === 0;
  const buttons: Button[][] = [];
  if (refundOwed > 0) buttons.push([{ text: "💸 Give refund details", data: `r:o:${order.id}` }]);
  buttons.push([MY_ORDERS]);
  return {
    screen: {
      text: cancelled
        ? `Your order ${orderNumber(order.id)} was cancelled because nothing was left to deliver.\n\nWe owe you ${formatEtb(refundOwed)}. Tap the button to tell us where to send it.`
        : refundOwed > 0
          ? `✅ Your order ${orderNumber(order.id)} was updated.\n\nWe owe you ${formatEtb(refundOwed)}. Tap the button to tell us where to send it.`
          : `✅ Your order ${orderNumber(order.id)} was updated. Nothing more to pay.`,
      buttons,
    },
    adminNotify: {
      text: `ℹ️ Order ${orderNumber(order.id)} was ${cancelled ? "cancelled" : "changed"} by the customer (an item was unavailable).${refundOwed > 0 ? `\nRefund owed: ${formatEtb(refundOwed)}.` : ""}`,
      buttons: [[{ text: "Open order", data: `a:oo:${order.id}` }]],
    },
  };
}

// ---------- buttons ----------

const PATTERN = /^(ch:\d{1,9}|chr:\d{1,9}|chu:\d{1,9}|chv:\d{1,9}|chh:\d{1,9}|chi:\d{1,9}:\d{1,9}|(chq|chy|chp):\d{1,9}:\d{1,9}:\d{1,2}|chm:\d{1,9}:\d{1,9}:\d{1,2}:(cbe|cbb))$/;

export async function handleChangeCallback(db: Db, user: User, data: string, now: number): Promise<FlowResult | null> {
  if (!PATTERN.test(data)) return null;
  const parts = data.split(":");
  const code = parts[0];
  const orderId = Number(parts[1]);

  const flagged = await loadFlagged(db, user, orderId);
  if ("error" in flagged) return flagged.error;
  const { order, missing } = flagged;
  const missingIds = order.missingIds;

  if (code === "ch") return { screen: optionsScreen(order, missing) };

  if (code === "chh") {
    return {
      screen: { text: "✅ We've told ZIPPY. Someone will message you here about your order.", buttons: [[MY_ORDERS]] },
      adminNotify: {
        text: `📞 The customer of order ${orderNumber(order.id)} (${order.name}) wants to talk about the unavailable item (${missing.map((m) => m.name).join(", ")}).`,
        buttons: [
          [{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${order.customerId}` }],
          [{ text: "Open order", data: `a:oo:${order.id}` }],
        ],
      },
    };
  }

  // ----- request a refund for the missing item(s) -----
  if (code === "chu" || code === "chv") {
    const re = reprice(order, missingIds);
    if (!re) return { toast: "We couldn't work out the new total. Please contact the admin.", alert: true };
    const owed = order.total - re.total;
    if (code === "chu") {
      return {
        screen: {
          text:
            `💸 Refund for ${missing.map((m) => m.name).join(", ")}\n\n` +
            (re.items.length === 0
              ? `Nothing else is left in the order, so the order will be cancelled and we'll refund ${formatEtb(owed)}.`
              : `Your order will continue without it.\n\n${summaryText(order, re)}`) +
            "\n\nContinue?",
          buttons: [[{ text: "✅ Yes, refund me", data: `chv:${order.id}` }], [{ text: "⬅ Back", data: `ch:${order.id}` }]],
        },
      };
    }
    const ok = await applyChange(db, order, re, "unavailable", now);
    return ok ? doneResult(order, re, owed) : { toast: "This order changed in the meantime. Please open it again.", alert: true };
  }

  // ----- change my order -----
  if (code === "chr") {
    const menu = await listMenu(db, order.cafeteriaId);
    const options = menu.filter((m) => m.available && !missingIds.includes(m.id));
    if (options.length === 0) return { toast: "There is nothing available to swap in right now.", alert: true };
    return {
      screen: {
        text: "✏️ Change My Order\n\nWhat would you like instead?",
        buttons: [
          ...options.map((m) => [{ text: `${m.name} — ${formatEtb(m.priceSantim)}`, data: `chi:${order.id}:${m.id}` }]),
          [{ text: "⬅ Back", data: `ch:${order.id}` }],
        ],
      },
    };
  }

  const itemId = Number(parts[2]);
  const menu = await listMenu(db, order.cafeteriaId);
  const chosen = menu.find((m) => m.id === itemId && m.available && !missingIds.includes(m.id));
  if (!chosen) return { toast: "That item isn't available any more. Please choose another.", alert: true };

  if (code === "chi") {
    const rows: Button[][] = [];
    for (let q = 1; q <= MAX_QTY_PER_ITEM; q += 5) {
      rows.push(
        Array.from({ length: Math.min(5, MAX_QTY_PER_ITEM - q + 1) }, (_, k) => ({ text: String(q + k), data: `chq:${order.id}:${chosen.id}:${q + k}` })),
      );
    }
    rows.push([{ text: "⬅ Back", data: `chr:${order.id}` }]);
    return { screen: { text: `${chosen.name} — ${formatEtb(chosen.priceSantim)} each\n\nHow many portions?`, buttons: rows } };
  }

  const qty = Number(parts[3]);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) return { toast: "That quantity isn't allowed.", alert: true };
  const re = reprice(order, missingIds, { id: chosen.id, name: chosen.name, unit: chosen.priceSantim, qty });
  if (!re) return { toast: `You can order up to ${MAX_QTY_PER_ITEM} portions of one food.`, alert: true };
  const delta = re.total - order.total;

  if (code === "chq") {
    return {
      screen: {
        text: `✏️ New version of order ${orderNumber(order.id)}\n\n${summaryText(order, re)}`,
        buttons: [
          [
            delta > 0
              ? { text: `💳 Pay the ${formatEtb(delta)} difference`, data: `chp:${order.id}:${chosen.id}:${qty}` }
              : { text: "✅ Confirm this change", data: `chy:${order.id}:${chosen.id}:${qty}` },
          ],
          [{ text: "⬅ Choose something else", data: `chr:${order.id}` }],
        ],
      },
    };
  }

  if (code === "chy") {
    if (delta > 0) return { toast: "This change needs a payment first.", alert: true };
    const ok = await applyChange(db, order, re, "changed", now);
    return ok ? doneResult(order, re, -delta) : { toast: "This order changed in the meantime. Please open it again.", alert: true };
  }

  if (code === "chp") {
    if (delta <= 0) return { toast: "No payment is needed for this change.", alert: true };
    const buttons: Button[][] = [];
    for (const m of Object.keys(METHODS) as Method[]) {
      const ready = (await getInstructions(db, m)) !== null;
      buttons.push([
        ready
          ? { text: METHODS[m].button, data: `chm:${order.id}:${chosen.id}:${qty}:${METHODS[m].code}` }
          : { text: `${METHODS[m].label} — not available yet`, data: "p:na" },
      ]);
    }
    buttons.push([{ text: "⬅ Back", data: `chq:${order.id}:${chosen.id}:${qty}` }]);
    return { screen: { text: `💳 How would you like to pay the ${formatEtb(delta)} difference?`, buttons } };
  }

  // chm: lock the difference and show the admin's payment instructions
  if (delta <= 0) return { toast: "No payment is needed for this change.", alert: true };
  const method: Method = parts[4] === "cbe" ? "cbe" : "cbe_birr";
  const instructions = await getInstructions(db, method);
  if (!instructions) return { toast: "That payment method isn't available yet.", alert: true };
  const open = await openSession(db, user.id, now);
  if (open && open.status === "under_verification") return { toast: "You already have a payment being checked. Please wait for it.", alert: true };
  const session = await createTopupSession(
    db, user, order, { items: re.items, subtotal: re.subtotal, fee: re.fee, portions: re.portions, delta }, method, now,
  );
  if (!session) return { toast: "Something went wrong. Please try again.", alert: true };
  await setState(db, user.id, { step: "pay_photo", sessionId: session.id }, now);
  return { screen: instructionsScreen(session, instructions) };
}
