// ZIPPY admin tools for payments and orders. Only reached for an admin (bot.ts checks the Telegram ID first).
// - Confirm payment: in ONE all-or-nothing step the order is created, the paid items leave the customer's cart,
//   and who/when is recorded. Nothing is "paid" until this happens.
// - Reject payment: the customer is told why and can try again.
// - Manage Orders: move an order along its allowed statuses; the customer is told each time.

import {
  ADMIN_PANEL_BUTTON, clearState, confirmScreen, setState,
  type Notify, type OrderAction, type Outcome,
} from "./admin-state";
import { overviewScreen } from "./admin-payments";
import { formatEtb } from "./cart";
import type { Db } from "./db";
import { ALLOWED, STATUS_ICON, STATUS_LABEL, PAYMENT_LABEL, dateTimeText, getOrder, getOrderBySession, orderNumber, receiptText, statusMessage, type Order, type OrderStatus } from "./orders";
import { METHODS, getSession } from "./payment";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type OrdersResult = { screen?: Screen; toast?: string; alert?: boolean; notify?: Notify[] };

export const isOrdersAction = (action: { type: string }): action is OrderAction =>
  action.type === "pay_verify" || action.type === "pay_reject" || action.type === "order_status";

const STATUS_CODE: Record<string, OrderStatus> = {
  c: "confirmed", p: "preparing", r: "ready", o: "out_for_delivery", d: "completed", x: "cancelled",
};
const CODE_OF: Record<OrderStatus, string> = {
  confirmed: "c", preparing: "p", ready: "r", out_for_delivery: "o", completed: "d", cancelled: "x",
};

const REJECT_REASONS: Record<string, string> = {
  n: "we could not find the payment in our account",
  w: "the amount did not match the total of your order",
  f: "we could not find that transaction reference",
  u: "the screenshot was not clear enough",
};

const BACK_TO_ORDERS: Button = { text: "⬅ Manage Orders", data: "a:orders" };

// ---------- screens ----------

async function overview(db: Db): Promise<Screen> {
  const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all<Row>();
  const count = (s: OrderStatus) => Number(results.find((r) => String(r.status) === s)?.n ?? 0);
  const order: OrderStatus[] = ["confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];
  return {
    text: "📦 Manage Orders\n\n" + order.map((s) => `${STATUS_ICON[s]} ${STATUS_LABEL[s]}: ${count(s)}`).join("\n"),
    buttons: [
      ...order.map((s) => [{ text: `${STATUS_ICON[s]} ${STATUS_LABEL[s]} (${count(s)})`, data: `a:ol:${CODE_OF[s]}` }]),
      [{ text: "💳 Payments waiting to be checked", data: "a:pay" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function listScreen(db: Db, status: OrderStatus): Promise<Screen> {
  // Orders still to be handled: oldest first. Finished orders: newest first.
  const finished = status === "completed" || status === "cancelled";
  const { results } = await db
    .prepare(`SELECT id, customer_name, total_santim FROM orders WHERE status = ? ORDER BY id ${finished ? "DESC" : "ASC"} LIMIT 15`)
    .bind(status)
    .all<Row>();
  return {
    text: `${STATUS_ICON[status]} ${STATUS_LABEL[status]} orders\n\n${results.length === 0 ? "None." : finished ? "The latest 15. Tap one for details." : "Oldest first. Tap one for details."}`,
    buttons: [
      ...results.map((r) => [
        { text: `${orderNumber(Number(r.id))} — ${formatEtb(Number(r.total_santim))} — ${String(r.customer_name)}`, data: `a:oo:${Number(r.id)}` },
      ]),
      [BACK_TO_ORDERS],
    ],
  };
}

const NEXT_BUTTON: Partial<Record<OrderStatus, string>> = {
  confirmed: "👨‍🍳 Start preparing",
  preparing: "📦 Mark ready for delivery",
  ready: "🚴 Out for delivery",
  out_for_delivery: "✅ Mark completed",
};

async function detailScreen(db: Db, o: Order): Promise<Screen> {
  const { results } = await db
    .prepare("SELECT to_status, at FROM order_status_history WHERE order_id = ? ORDER BY id")
    .bind(o.id)
    .all<Row>();
  const history = results.map((r) => `• ${STATUS_LABEL[String(r.to_status) as OrderStatus] ?? String(r.to_status)} — ${dateTimeText(Number(r.at))}`);
  const text = [
    `${STATUS_ICON[o.status]} Order ${orderNumber(o.id)} — ${STATUS_LABEL[o.status]}`,
    `Payment: ${METHODS[o.method].label} — ${PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus}`,
    "",
    `Customer: ${o.name}`,
    `Phone: ${o.phone ?? "not shared"}`,
    `Deliver to: ${o.location}`,
    "",
    ...o.items.map((i) => `${i.qty} × ${i.name} — ${formatEtb(i.unit * i.qty)}`),
    `Food subtotal: ${formatEtb(o.subtotal)}`,
    `Delivery fee (${o.portions} portion${o.portions === 1 ? "" : "s"}): ${formatEtb(o.fee)}`,
    `Total: ${formatEtb(o.total)}`,
    `Bank reference: ${o.bankReference}`,
    "",
    "History:",
    ...history,
  ].join("\n");

  const buttons: Button[][] = [];
  const next = ALLOWED[o.status].find((s) => s !== "cancelled");
  if (next) buttons.push([{ text: NEXT_BUTTON[o.status] ?? STATUS_LABEL[next], data: `a:os:${o.id}:${CODE_OF[next]}` }]);
  if (ALLOWED[o.status].includes("cancelled")) buttons.push([{ text: "❌ Cancel order", data: `a:os:${o.id}:x` }]);
  buttons.push([{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${o.customerId}` }]);
  buttons.push([{ text: `⬅ ${STATUS_LABEL[o.status]} orders`, data: `a:ol:${CODE_OF[o.status]}` }]);
  return { text, buttons };
}

// ---------- buttons ----------

export async function handleOrdersCallback(db: Db, adminId: number, data: string, now: number): Promise<OrdersResult | null> {
  if (data === "a:orders") {
    await clearState(db, adminId);
    return { screen: await overview(db) };
  }

  let m = /^a:ol:([cprodx])$/.exec(data);
  if (m) return { screen: await listScreen(db, STATUS_CODE[m[1]]) };

  m = /^a:oo:(\d{1,9})$/.exec(data);
  if (m) {
    const o = await getOrder(db, Number(m[1]));
    return o ? { screen: await detailScreen(db, o) } : { screen: await overview(db), toast: "That order was not found." };
  }

  m = /^a:os:(\d{1,9}):([prodx])$/.exec(data);
  if (m) {
    const o = await getOrder(db, Number(m[1]));
    if (!o) return { screen: await overview(db), toast: "That order was not found." };
    const to = STATUS_CODE[m[2]];
    if (!ALLOWED[o.status].includes(to)) {
      return { screen: await detailScreen(db, o), toast: "That change isn't allowed from the current status.", alert: true };
    }
    // Finishing or cancelling an order asks for confirmation. The other steps happen straight away.
    if (to === "completed" || to === "cancelled") {
      await setState(db, adminId, { step: "confirm", action: { type: "order_status", orderId: o.id, from: o.status, to } }, now);
      return {
        screen: confirmScreen(
          to === "completed"
            ? `Mark order ${orderNumber(o.id)} as completed (delivered)?`
            : `Cancel order ${orderNumber(o.id)}?\n\nThe customer has already paid. Cancelling marks the payment as "refund pending" and tells the customer. Refunds are handled in a later step, and are never marked done until the money is really sent.`,
        ),
      };
    }
    const outcome = await applyOrdersAction(db, adminId, { type: "order_status", orderId: o.id, from: o.status, to }, now);
    return { screen: outcome.screen, toast: outcome.message, alert: !outcome.ok, notify: outcome.notify };
  }

  m = /^a:pv:(\d{1,9})$/.exec(data);
  if (m) {
    const s = await getSession(db, Number(m[1]));
    if (!s || s.status !== "under_verification") return { screen: await overviewScreen(db), toast: "That payment is not waiting to be checked.", alert: true };
    await setState(db, adminId, { step: "confirm", action: { type: "pay_verify", sessionId: s.id } }, now);
    return {
      screen: confirmScreen(
        `Confirm payment #${s.id}?\n\nOnly confirm if you have checked your REAL ${METHODS[s.method].label} account and ${formatEtb(s.total)} has arrived (reference ${s.bankReference}).\n\n` +
          `This creates the order for ${s.name}.`,
      ),
    };
  }

  m = /^a:px:(\d{1,9})$/.exec(data);
  if (m) {
    const s = await getSession(db, Number(m[1]));
    if (!s || s.status !== "under_verification") return { screen: await overviewScreen(db), toast: "That payment is not waiting to be checked.", alert: true };
    return {
      screen: {
        text: `Why are you rejecting payment #${s.id}? The customer will be told.`,
        buttons: [
          [{ text: "Payment not found", data: `a:pr:${s.id}:n` }],
          [{ text: "Wrong amount", data: `a:pr:${s.id}:w` }],
          [{ text: "Reference not found", data: `a:pr:${s.id}:f` }],
          [{ text: "Screenshot not clear", data: `a:pr:${s.id}:u` }],
          [{ text: "✖ Back", data: `a:ps:${s.id}` }],
        ],
      },
    };
  }

  m = /^a:pr:(\d{1,9}):([nwfu])$/.exec(data);
  if (m) {
    const s = await getSession(db, Number(m[1]));
    if (!s || s.status !== "under_verification") return { screen: await overviewScreen(db), toast: "That payment is not waiting to be checked.", alert: true };
    const reason = REJECT_REASONS[m[2]];
    await setState(db, adminId, { step: "confirm", action: { type: "pay_reject", sessionId: s.id, reason } }, now);
    return { screen: confirmScreen(`Reject payment #${s.id}?\n\nThe customer will be told that ${reason}.`) };
  }
  return null;
}

// ---------- applying a confirmed change (all or nothing) ----------

export async function applyOrdersAction(db: Db, adminId: number, action: OrderAction, now: number): Promise<Outcome> {
  if (action.type === "pay_verify") {
    const before = await getSession(db, action.sessionId);
    if (!before || before.status !== "under_verification") {
      return { ok: false, message: "That payment was already handled. Nothing was changed.", screen: await overviewScreen(db) };
    }
    try {
      await db.batch([
        // 1) record who verified it (only while it is still waiting)
        db
          .prepare("INSERT INTO payment_events (session_id, event, actor_telegram_id, reason, at) SELECT ?, 'verified', ?, '', ? WHERE EXISTS (SELECT 1 FROM checkout_sessions WHERE id = ? AND status = 'under_verification')")
          .bind(action.sessionId, adminId, now, action.sessionId),
        // 2) create the order from the locked session (a second tap can't create a second order)
        db
          .prepare(
            "INSERT INTO orders (session_id, customer_id, cafeteria_id, status, payment_status, method, subtotal_santim, fee_santim, total_santim, portions, items_json, customer_name, customer_phone, location_json, bank_reference, created_at, updated_at) " +
              "SELECT s.id, s.customer_id, s.cafeteria_id, 'confirmed', 'verified', s.method, s.subtotal_santim, s.fee_santim, s.total_santim, s.portions, s.items_json, s.customer_name, " +
              "(SELECT phone FROM customers WHERE telegram_user_id = s.customer_id), s.location_json, s.bank_reference, ?, ? " +
              "FROM checkout_sessions s WHERE s.id = ? AND s.status = 'under_verification' AND s.bank_reference IS NOT NULL",
          )
          .bind(now, now, action.sessionId),
        // 3) the first line of the order's history
        db
          .prepare(
            "INSERT INTO order_status_history (order_id, from_status, to_status, actor_telegram_id, at) " +
              "SELECT o.id, NULL, 'confirmed', ?, ? FROM orders o WHERE o.session_id = ? AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id)",
          )
          .bind(adminId, now, action.sessionId),
        // 4) take the paid items out of the cart (items the customer added since stay)
        db
          .prepare(
            "DELETE FROM cart_items WHERE telegram_user_id = (SELECT customer_id FROM checkout_sessions WHERE id = ?) " +
              "AND menu_item_id IN (SELECT json_extract(value, '$.id') FROM json_each((SELECT items_json FROM checkout_sessions WHERE id = ?))) " +
              "AND EXISTS (SELECT 1 FROM checkout_sessions WHERE id = ? AND status = 'under_verification') " +
              "AND EXISTS (SELECT 1 FROM orders WHERE session_id = ?)",
          )
          .bind(action.sessionId, action.sessionId, action.sessionId, action.sessionId),
        db
          .prepare(
            "DELETE FROM carts WHERE telegram_user_id = (SELECT customer_id FROM checkout_sessions WHERE id = ?) " +
              "AND NOT EXISTS (SELECT 1 FROM cart_items WHERE telegram_user_id = carts.telegram_user_id)",
          )
          .bind(action.sessionId),
        // 5) finally mark the payment verified
        db
          .prepare("UPDATE checkout_sessions SET status = 'verified' WHERE id = ? AND status = 'under_verification' AND EXISTS (SELECT 1 FROM orders WHERE session_id = ?)")
          .bind(action.sessionId, action.sessionId),
      ]);
    } catch {
      return { ok: false, message: "Something went wrong. Nothing was changed.", screen: await overviewScreen(db) };
    }
    const order = await getOrderBySession(db, action.sessionId);
    if (!order) return { ok: false, message: "Nothing was changed.", screen: await overviewScreen(db) };
    return {
      ok: true,
      message: `Payment confirmed. Order ${orderNumber(order.id)} created.`,
      screen: await detailScreen(db, order),
      notify: [{ chatId: order.customerId, text: `✅ Payment confirmed! Your order is confirmed.\n\n${receiptText(order)}` }],
    };
  }

  if (action.type === "pay_reject") {
    const before = await getSession(db, action.sessionId);
    if (!before || before.status !== "under_verification") {
      return { ok: false, message: "That payment was already handled. Nothing was changed.", screen: await overviewScreen(db) };
    }
    await db.batch([
      db
        .prepare("INSERT INTO payment_events (session_id, event, actor_telegram_id, reason, at) SELECT ?, 'rejected', ?, ?, ? WHERE EXISTS (SELECT 1 FROM checkout_sessions WHERE id = ? AND status = 'under_verification')")
        .bind(action.sessionId, adminId, action.reason, now, action.sessionId),
      db.prepare("UPDATE checkout_sessions SET status = 'rejected' WHERE id = ? AND status = 'under_verification'").bind(action.sessionId),
    ]);
    const after = await getSession(db, action.sessionId);
    if (!after || after.status !== "rejected") return { ok: false, message: "Nothing was changed.", screen: await overviewScreen(db) };
    return {
      ok: true,
      message: `Payment #${after.id} rejected.`,
      screen: await overviewScreen(db),
      notify: [
        {
          chatId: after.customerId,
          text:
            `❌ We couldn't confirm your payment (#${after.id}): ${action.reason}.\n\nYour cart is saved. If you really did pay, please contact ZIPPY. ` +
            "You can start a new payment from your cart.",
        },
      ],
    };
  }

  // order_status
  const o = await getOrder(db, action.orderId);
  if (!o) return { ok: false, message: "That order was not found.", screen: await overview(db) };
  const to = action.to as OrderStatus;
  if (o.status !== action.from || !ALLOWED[o.status].includes(to)) {
    return { ok: false, message: "The order's status changed in the meantime. Nothing was changed.", screen: await detailScreen(db, o) };
  }
  await db.batch([
    db
      .prepare("INSERT INTO order_status_history (order_id, from_status, to_status, actor_telegram_id, at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = ?)")
      .bind(o.id, o.status, to, adminId, now, o.id, o.status),
    db
      .prepare(
        "UPDATE orders SET status = ?, updated_at = ?, " +
          "payment_status = CASE WHEN ? = 'cancelled' AND payment_status = 'verified' THEN 'refund_pending' ELSE payment_status END " +
          "WHERE id = ? AND status = ?",
      )
      .bind(to, now, to, o.id, o.status),
  ]);
  const fresh = await getOrder(db, o.id);
  if (!fresh || fresh.status !== to) {
    return { ok: false, message: "The order's status changed in the meantime. Nothing was changed.", screen: fresh ? await detailScreen(db, fresh) : await overview(db) };
  }
  return {
    ok: true,
    message: `Order ${orderNumber(fresh.id)} is now ${STATUS_LABEL[to]}.`,
    screen: await detailScreen(db, fresh),
    notify: [{ chatId: fresh.customerId, text: statusMessage(fresh, to) }],
  };
}

