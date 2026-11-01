// ZIPPY admin tools for payments and orders. Only reached for an admin (bot.ts checks the Telegram ID first).
// - Confirm payment: in ONE all-or-nothing step the order is created, the paid items leave the customer's cart,
//   and who/when is recorded. Nothing is "paid" until this happens.
// - Reject payment: the customer is told why and can try again.
// - Manage Orders: move an order along its allowed statuses; the customer is told each time.

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, clearState, confirmScreen, setState,
  type Notify, type OrderAction, type Outcome,
} from "./admin-state";
import { overviewScreen } from "./admin-payments";
import { formatEtb } from "./cart";
import type { Db } from "./db";
import { ALLOWED, STATUS_ICON, STATUS_LABEL, PAYMENT_LABEL, dateTimeText, getOrder, getOrderBySession, orderNumber, receiptText, statusMessage, type Order, type OrderStatus } from "./orders";
import { METHODS, displayReference, getSession } from "./payment";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type OrdersResult = { screen?: Screen; toast?: string; alert?: boolean; notify?: Notify[] };

export const isOrdersAction = (action: { type: string }): action is OrderAction =>
  action.type === "pay_verify" || action.type === "pay_reject" || action.type === "order_status" || action.type === "order_missing";

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
  const refundsOpen = Number((await db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE status IN ('pending', 'processing')").first<Row>())?.n ?? 0);
  const count = (s: OrderStatus) => Number(results.find((r) => String(r.status) === s)?.n ?? 0);
  const order: OrderStatus[] = ["confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];
  return {
    text: "📦 Manage Orders\n\n" + order.map((s) => `${STATUS_ICON[s]} ${STATUS_LABEL[s]}: ${count(s)}`).join("\n"),
    buttons: [
      ...order.map((s) => [{ text: `${STATUS_ICON[s]} ${STATUS_LABEL[s]} (${count(s)})`, data: `a:ol:${CODE_OF[s]}` }]),
      [{ text: `💸 Refund requests (${refundsOpen})`, data: "a:rq" }],
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
    ...(o.needsAction
      ? [`⚠️ Waiting for the customer to decide (unavailable: ${o.items.filter((i) => o.missingIds.includes(i.id)).map((i) => i.name).join(", ")})`]
      : []),
    "",
    `Customer: ${o.name}`,
    `Phone: ${o.phone ?? "not shared"}`,
    `Deliver to: ${o.location}`,
    "",
    ...o.items.map((i) => `${i.qty} × ${i.name} — ${formatEtb(i.unit * i.qty)}`),
    `Food subtotal: ${formatEtb(o.subtotal)}`,
    `Delivery fee (${o.portions} portion${o.portions === 1 ? "" : "s"}): ${formatEtb(o.fee)}`,
    `Total: ${formatEtb(o.total)}`,
    displayReference(o.bankReference) ? `Bank reference: ${displayReference(o.bankReference)}` : "",
    "",
    "History:",
    ...history,
  ].join("\n");

  const buttons: Button[][] = [];
  if (o.needsAction) {
    buttons.push([{ text: "↩️ Item is available after all", data: `a:oz:${o.id}` }]);
  } else {
    const next = ALLOWED[o.status].find((s) => s !== "cancelled");
    if (next) buttons.push([{ text: NEXT_BUTTON[o.status] ?? STATUS_LABEL[next], data: `a:os:${o.id}:${CODE_OF[next]}` }]);
    if (["confirmed", "preparing", "ready"].includes(o.status)) buttons.push([{ text: "⚠️ Item unavailable", data: `a:ox:${o.id}` }]);
  }
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
    if (o.needsAction && to !== "cancelled") {
      return { screen: await detailScreen(db, o), toast: "Waiting for the customer's decision about the unavailable item.", alert: true };
    }
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

  m = /^a:ox:(\d{1,9})$/.exec(data);
  if (m) {
    const o = await getOrder(db, Number(m[1]));
    if (!o) return { screen: await overview(db), toast: "That order was not found." };
    if (o.needsAction || !["confirmed", "preparing", "ready"].includes(o.status)) {
      return { screen: await detailScreen(db, o), toast: "You can't mark an item on this order right now.", alert: true };
    }
    return {
      screen: {
        text: `Which item of order ${orderNumber(o.id)} is unavailable?`,
        buttons: [...o.items.map((i) => [{ text: `${i.qty} × ${i.name}`, data: `a:oy:${o.id}:${i.id}` }]), [{ text: "⬅ Back", data: `a:oo:${o.id}` }]],
      },
    };
  }

  m = /^a:oy:(\d{1,9}):(\d{1,9})$/.exec(data);
  if (m) {
    const o = await getOrder(db, Number(m[1]));
    const item = o?.items.find((i) => i.id === Number(m![2]));
    if (!o || !item || o.needsAction || !["confirmed", "preparing", "ready"].includes(o.status)) {
      return { screen: o ? await detailScreen(db, o) : await overview(db), toast: "Nothing can be changed here now.", alert: true };
    }
    await setState(db, adminId, { step: "confirm", action: { type: "order_missing", orderId: o.id, itemId: item.id } }, now);
    return {
      screen: confirmScreen(
        `Tell ${o.name} that ${item.name} is unavailable for order ${orderNumber(o.id)}?\n\nThey will be asked to change the order, request a refund, or contact you. The order stays on hold until they answer.`,
      ),
    };
  }

  m = /^a:oz:(\d{1,9})$/.exec(data);
  if (m) {
    const o = await getOrder(db, Number(m[1]));
    if (!o || !o.needsAction) return { screen: o ? await detailScreen(db, o) : await overview(db), toast: "Nothing is on hold for this order." };
    const topup = await db
      .prepare("SELECT id FROM checkout_sessions WHERE order_id = ? AND status IN ('awaiting_payment', 'under_verification')")
      .bind(o.id)
      .first();
    if (topup) {
      return { screen: await detailScreen(db, o), toast: "The customer is paying for a change. Wait until that payment is checked.", alert: true };
    }
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'order.item_available_again', ?, '{}' WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND needs_action = 1)")
        .bind(now, adminId, `order:${o.id}`, o.id),
      db.prepare("UPDATE orders SET needs_action = 0, missing_json = NULL, updated_at = ? WHERE id = ? AND needs_action = 1").bind(now, o.id),
    ]);
    const fresh = await getOrder(db, o.id);
    if (!fresh || fresh.needsAction) return { screen: await detailScreen(db, o), toast: "Nothing was changed.", alert: true };
    return {
      screen: await detailScreen(db, fresh),
      toast: "Order released.",
      notify: [{ chatId: fresh.customerId, text: `✅ Good news: everything in your order ${orderNumber(fresh.id)} is available after all. Nothing for you to do.` }],
    };
  }

  m = /^a:pv:(\d{1,9})$/.exec(data);
  if (m) {
    const s = await getSession(db, Number(m[1]));
    if (!s || s.status !== "under_verification") return { screen: await overviewScreen(db), toast: "That payment is not waiting to be checked.", alert: true };
    await setState(db, adminId, { step: "confirm", action: { type: "pay_verify", sessionId: s.id } }, now);
    return {
      screen: confirmScreen(
        `Confirm payment #${s.id}?\n\nOnly confirm if you have checked your REAL ${METHODS[s.method].label} account and ${formatEtb(s.total)} has arrived${displayReference(s.bankReference) ? ` (reference ${displayReference(s.bankReference)})` : ""}.\n\n` +
          (s.orderId !== null ? `This updates order ${orderNumber(s.orderId)} for ${s.name}.` : `This creates the order for ${s.name}.`),
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
  if (action.type === "order_missing") {
    const o = await getOrder(db, action.orderId);
    const item = o?.items.find((i) => i.id === action.itemId);
    if (!o || !item || o.needsAction || !["confirmed", "preparing", "ready"].includes(o.status)) {
      return { ok: false, message: "Nothing was changed.", screen: o ? await detailScreen(db, o) : await overview(db) };
    }
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'order.item_unavailable', ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND needs_action = 0 AND status IN ('confirmed', 'preparing', 'ready'))")
        .bind(now, adminId, `order:${o.id}`, JSON.stringify({ item: item.name }), o.id),
      db
        .prepare("UPDATE orders SET needs_action = 1, missing_json = ?, updated_at = ? WHERE id = ? AND needs_action = 0 AND status IN ('confirmed', 'preparing', 'ready')")
        .bind(JSON.stringify([item.id]), now, o.id),
    ]);
    const fresh = await getOrder(db, o.id);
    if (!fresh || !fresh.needsAction) return { ok: false, message: "Nothing was changed.", screen: await detailScreen(db, o) };
    return {
      ok: true,
      message: `${item.name} marked unavailable. The customer was asked what to do.`,
      screen: await detailScreen(db, fresh),
      notify: [
        {
          chatId: fresh.customerId,
          text: `⚠️ Sorry, ${item.name} isn't available for your order ${orderNumber(fresh.id)}.\n\nWhat would you like to do?`,
          buttons: [
            [{ text: "✏️ Change My Order", data: `chr:${fresh.id}` }],
            [{ text: "💸 Request Refund", data: `chu:${fresh.id}` }],
            [{ text: "📞 Contact Admin", data: `chh:${fresh.id}` }],
          ],
        },
      ],
    };
  }

  if (action.type === "pay_verify") {
    const before = await getSession(db, action.sessionId);
    if (!before || before.status !== "under_verification") {
      return { ok: false, message: "That payment was already handled. Nothing was changed.", screen: await overviewScreen(db) };
    }
    if (before.orderId !== null) {
      // The difference for an existing order: update that order instead of creating a new one.
      const sid = action.sessionId;
      try {
        await db.batch([
          db
            .prepare(
              "INSERT INTO payment_events (session_id, event, actor_telegram_id, reason, at) SELECT ?, 'verified', ?, '', ? " +
                "WHERE EXISTS (SELECT 1 FROM checkout_sessions WHERE id = ? AND status = 'under_verification') " +
                "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND needs_action = 1)",
            )
            .bind(sid, adminId, now, sid, before.orderId),
          db
            .prepare(
              "UPDATE orders SET items_json = (SELECT items_json FROM checkout_sessions WHERE id = ?), " +
                "subtotal_santim = (SELECT subtotal_santim FROM checkout_sessions WHERE id = ?), fee_santim = (SELECT fee_santim FROM checkout_sessions WHERE id = ?), " +
                "portions = (SELECT portions FROM checkout_sessions WHERE id = ?), total_santim = (SELECT subtotal_santim + fee_santim FROM checkout_sessions WHERE id = ?), " +
                "paid_santim = COALESCE(paid_santim, total_santim) + (SELECT total_santim FROM checkout_sessions WHERE id = ?), needs_action = 0, missing_json = NULL, updated_at = ? " +
                "WHERE id = ? AND needs_action = 1 AND EXISTS (SELECT 1 FROM checkout_sessions WHERE id = ? AND status = 'under_verification')",
            )
            .bind(sid, sid, sid, sid, sid, sid, now, before.orderId, sid),
          db
            .prepare(
              "UPDATE checkout_sessions SET status = 'verified' WHERE id = ? AND status = 'under_verification' " +
                "AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.needs_action = 0 AND o.items_json = (SELECT items_json FROM checkout_sessions WHERE id = ?))",
            )
            .bind(sid, before.orderId, sid),
        ]);
      } catch {
        return { ok: false, message: "Something went wrong. Nothing was changed.", screen: await overviewScreen(db) };
      }
      const updated = await getOrder(db, before.orderId);
      const afterSession = await getSession(db, sid);
      if (!updated || !afterSession || afterSession.status !== "verified") {
        return { ok: false, message: "Nothing was changed. (Was the order released in the meantime?)", screen: await overviewScreen(db) };
      }
      return {
        ok: true,
        message: `Payment confirmed. Order ${orderNumber(updated.id)} updated.`,
        screen: await detailScreen(db, updated),
        notify: [{ chatId: updated.customerId, text: `✅ Payment confirmed! Your order ${orderNumber(updated.id)} has been updated.\n\n${receiptText(updated)}` }],
      };
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
            "INSERT INTO orders (session_id, customer_id, cafeteria_id, status, payment_status, method, subtotal_santim, fee_santim, total_santim, portions, items_json, customer_name, customer_phone, location_json, bank_reference, paid_santim, created_at, updated_at) " +
              "SELECT s.id, s.customer_id, s.cafeteria_id, 'confirmed', 'verified', s.method, s.subtotal_santim, s.fee_santim, s.total_santim, s.portions, s.items_json, s.customer_name, " +
              "(SELECT phone FROM customers WHERE telegram_user_id = s.customer_id), s.location_json, s.bank_reference, s.total_santim, ?, ? " +
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
    // Cancelling a paid order creates the refund (once). The customer then gives their account details.
    ...(to === "cancelled"
      ? [
          db
            .prepare(
              "INSERT INTO refunds (order_id, customer_id, amount_santim, reason, status, created_at, updated_at) " +
                "SELECT o.id, o.customer_id, o.total_santim, 'cancelled', 'awaiting_details', ?, ? FROM orders o " +
                "WHERE o.id = ? AND o.status = 'cancelled' AND o.total_santim > 0 " +
                "AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.reason = 'cancelled')",
            )
            .bind(now, now, o.id),
        ]
      : []),
  ]);
  const fresh = await getOrder(db, o.id);
  if (!fresh || fresh.status !== to) {
    return { ok: false, message: "The order's status changed in the meantime. Nothing was changed.", screen: fresh ? await detailScreen(db, fresh) : await overview(db) };
  }
  return {
    ok: true,
    message: `Order ${orderNumber(fresh.id)} is now ${STATUS_LABEL[to]}.`,
    screen: await detailScreen(db, fresh),
    notify: [
      {
        chatId: fresh.customerId,
        text: statusMessage(fresh, to),
        buttons: to === "cancelled" ? [[{ text: "💸 Give refund details", data: `r:o:${fresh.id}` }]] : undefined,
      },
    ],
  };
}

