// ZIPPY orders: what an order is, the allowed status changes, the receipt, and the customer's "My Orders".
// An order exists only after the admin has verified the payment. Payment status and order status are separate.

import { formatEtb } from "./cart";
import { localTime } from "./clock";
import { locationSummary } from "./checkout";
import type { Db } from "./db";
import { METHODS, itemsText, type Method } from "./payment";
import { dateKey } from "./schedule";
import { etTimeFromEpoch } from "./schedule-text";
import { CB, type Button, type Screen } from "./screens";

type Row = Record<string, unknown>;

export type OrderStatus = "confirmed" | "preparing" | "ready" | "out_for_delivery" | "completed" | "cancelled";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready for Delivery",
  out_for_delivery: "Out for Delivery",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const STATUS_ICON: Record<OrderStatus, string> = {
  confirmed: "🆕",
  preparing: "👨‍🍳",
  ready: "📦",
  out_for_delivery: "🚴",
  completed: "✅",
  cancelled: "❌",
};

// The only changes allowed. "completed" and "cancelled" are final.
export const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const PAYMENT_LABEL: Record<string, string> = {
  verified: "Verified ✅",
  refund_pending: "Refund pending",
  refunded: "Refunded",
};

export const REFUND_STATUS_LABEL: Record<string, string> = {
  awaiting_details: "Waiting for your details",
  pending: "Pending",
  processing: "Processing",
  refunded: "Refunded",
  declined: "Declined",
};

export type OrderItem = { id: number; name: string; unit: number; qty: number };

export type Order = {
  id: number;
  sessionId: number;
  customerId: number;
  cafeteriaName: string;
  status: OrderStatus;
  paymentStatus: string;
  method: Method;
  subtotal: number;
  fee: number;
  total: number;
  portions: number;
  items: OrderItem[];
  name: string;
  phone: string | null;
  location: string;
  bankReference: string;
  createdAt: number;
  updatedAt: number;
};

export const orderNumber = (id: number): string => `ZP-${String(id).padStart(4, "0")}`;

// "2026-10-27, 3:00 daytime (Ethiopian time)"
export function dateTimeText(epochSeconds: number): string {
  const t = localTime(epochSeconds);
  return `${dateKey(t.year, t.month, t.day)}, ${etTimeFromEpoch(epochSeconds)}`;
}

function toOrder(r: Row): Order {
  let items: OrderItem[] = [];
  try {
    items = JSON.parse(String(r.items_json));
  } catch {
    items = [];
  }
  let location = "(unknown)";
  try {
    location = locationSummary(JSON.parse(String(r.location_json)));
  } catch {
    // keep "(unknown)"
  }
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    customerId: Number(r.customer_id),
    cafeteriaName: String(r.cafeteria_name),
    status: String(r.status) as OrderStatus,
    paymentStatus: String(r.payment_status),
    method: String(r.method) as Method,
    subtotal: Number(r.subtotal_santim),
    fee: Number(r.fee_santim),
    total: Number(r.total_santim),
    portions: Number(r.portions),
    items,
    name: String(r.customer_name),
    phone: r.customer_phone === null ? null : String(r.customer_phone),
    location,
    bankReference: String(r.bank_reference),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const ORDER_SQL =
  "SELECT o.*, c.name AS cafeteria_name FROM orders o JOIN cafeterias c ON c.id = o.cafeteria_id";

export async function getOrder(db: Db, id: number): Promise<Order | null> {
  const r = await db.prepare(`${ORDER_SQL} WHERE o.id = ?`).bind(id).first<Row>();
  return r ? toOrder(r) : null;
}

export async function getOrderBySession(db: Db, sessionId: number): Promise<Order | null> {
  const r = await db.prepare(`${ORDER_SQL} WHERE o.session_id = ?`).bind(sessionId).first<Row>();
  return r ? toOrder(r) : null;
}

// The receipt. It only ever says "Verified" because an order exists only after verification.
export function receiptText(o: Order): string {
  const lines = o.items.map((i) => `${i.qty} × ${i.name} — ${formatEtb(i.unit * i.qty)}`);
  return [
    "🧾 ZIPPY Receipt",
    `Order: ${orderNumber(o.id)}`,
    `Name: ${o.name}`,
    `Date: ${dateTimeText(o.createdAt)}`,
    "Service: Cafeteria Delivery",
    `Cafeteria: ${o.cafeteriaName}`,
    "",
    ...lines,
    "",
    `Food subtotal: ${formatEtb(o.subtotal)}`,
    `Delivery fee (${o.portions} portion${o.portions === 1 ? "" : "s"}): ${formatEtb(o.fee)}`,
    `Total: ${formatEtb(o.total)}`,
    "",
    `Deliver to: ${o.location}`,
    `Payment: ${METHODS[o.method].label} — ${PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus}`,
    `Order status: ${STATUS_ICON[o.status]} ${STATUS_LABEL[o.status]}`,
  ].join("\n");
}

// What the customer is told when their order moves along.
export function statusMessage(o: Order, status: OrderStatus): string {
  const n = orderNumber(o.id);
  switch (status) {
    case "preparing":
      return `👨‍🍳 Your order ${n} is being prepared.`;
    case "ready":
      return `📦 Your order ${n} is ready for delivery.`;
    case "out_for_delivery":
      return `🚴 Your order ${n} is on its way to you!`;
    case "completed":
      return `✅ Your order ${n} has been delivered. Enjoy your meal!`;
    case "cancelled":
      return `❌ Your order ${n} was cancelled.\n\nYour payment of ${formatEtb(o.total)} was received, so we will refund it. Tap the button below to tell us where to send it. A refund is only marked as done once the money has really been sent.`;
    default:
      return `Your order ${n} is now: ${STATUS_LABEL[status]}.`;
  }
}

// ---------- the customer's My Orders ----------

const MAIN_MENU: Button = { text: "🏠 Main Menu", data: CB.main };
const BACK_TO_ORDERS: Button = { text: "⬅ My Orders", data: CB.orders };
const PREVIOUS_LIMIT = 10;

async function ordersScreen(db: Db, userId: number): Promise<Screen> {
  const current = await db
    .prepare(`${ORDER_SQL} WHERE o.customer_id = ? AND o.status NOT IN ('completed', 'cancelled') ORDER BY o.id DESC`)
    .bind(userId)
    .all<Row>();
  const previous = await db
    .prepare(`${ORDER_SQL} WHERE o.customer_id = ? AND o.status IN ('completed', 'cancelled') ORDER BY o.id DESC LIMIT ?`)
    .bind(userId, PREVIOUS_LIMIT)
    .all<Row>();
  // A payment that is still being checked is shown, but clearly NOT as a confirmed order.
  const pending = await db
    .prepare("SELECT total_santim FROM checkout_sessions WHERE customer_id = ? AND status = 'under_verification'")
    .bind(userId)
    .first<Row>();

  const button = (o: Order): Button[] => [
    { text: `${STATUS_ICON[o.status]} ${orderNumber(o.id)} — ${formatEtb(o.total)} — ${STATUS_LABEL[o.status]}`, data: `o:${o.id}` },
  ];
  const cur = current.results.map(toOrder);
  const prev = previous.results.map(toOrder);

  const text = [
    "📋 My Orders",
    "",
    pending ? `⏳ Payment being checked: ${formatEtb(Number(pending.total_santim))}\nThis is not a confirmed order yet.\n` : "",
    cur.length === 0 && prev.length === 0 && !pending ? "You don't have any orders yet." : "",
    cur.length > 0 ? "Current orders:" : "",
    prev.length > 0 ? `${cur.length > 0 ? "\n" : ""}Previous orders are listed below the current ones.` : "",
    cur.length > 0 || prev.length > 0 ? "\nTap an order to see its details." : "",
  ]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();

  return { text, buttons: [...cur.map(button), ...prev.map(button), [MAIN_MENU]] };
}

// Returns null if the button is not about orders. The customer comes from Telegram, never from the button.
export async function handleCustomerOrders(db: Db, userId: number, data: string): Promise<{ screen: Screen; toast?: string } | null> {
  if (data === CB.orders) return { screen: await ordersScreen(db, userId) };
  const m = /^o:(\d{1,9})$/.exec(data);
  if (!m) return null;
  const order = await getOrder(db, Number(m[1]));
  // Someone else's order is treated exactly like a missing one.
  if (!order || order.customerId !== userId) return { screen: await ordersScreen(db, userId), toast: "That order was not found." };
  const refund = await db
    .prepare("SELECT amount_santim, status FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1")
    .bind(order.id)
    .first<Row>();
  const refundLine = refund
    ? `\n\n💸 Refund: ${formatEtb(Number(refund.amount_santim))} — ${REFUND_STATUS_LABEL[String(refund.status)] ?? String(refund.status)}`
    : "";
  const buttons: Button[][] = [];
  if (refund && String(refund.status) === "awaiting_details") buttons.push([{ text: "💸 Give refund details", data: `r:o:${order.id}` }]);
  buttons.push([BACK_TO_ORDERS], [MAIN_MENU]);
  return {
    screen: { text: `${receiptText(order)}${refundLine}\n\nWe'll message you here as your order moves along.`, buttons },
  };
}

export { itemsText };
