// ZIPPY admin: Dashboard, Customer Statistics, All-Time Customers, Reports. Only reached for an admin.
// Customers are identified by their Telegram user ID, never by username (usernames can change).
// "Placed an order" means a CONFIRMED order: an order exists only after the payment was verified.
// Totals here are what the bot has recorded. They are not profit and not a replacement for your bank statement.

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, CANCEL, clearState, confirmScreen, setState,
  type AdminState, type CustomersAction, type Outcome,
} from "./admin-state";
import { formatEtb } from "./cart";
import { localTime } from "./clock";
import type { Db } from "./db";
import { STATUS_ICON, STATUS_LABEL, dateTimeText, orderNumber, type OrderStatus } from "./orders";
import { dateKey } from "./schedule";
import type { Button, Screen } from "./screens";

type Row = Record<string, unknown>;
export type CustomersResult = { screen?: Screen; toast?: string; alert?: boolean; document?: { filename: string; text: string } };

export const isCustomersStep = (step: string): boolean => step === "cust_search";
export const isCustomersAction = (action: { type: string }): action is CustomersAction => action.type === "export_customers";

const PAGE_SIZE = 8;
const DAY = 86_400;

// Remembers that someone pressed Start (their ID, and their username if they have one).
export async function recordUser(db: Db, userId: number, username: string | undefined, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO bot_users (telegram_user_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (telegram_user_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at",
    )
    .bind(userId, username ?? null, now, now)
    .run();
}

// ---------- periods (Addis Ababa days; the week starts on Monday) ----------

type Range = "t" | "w" | "m" | "a";
const RANGE_LABEL: Record<Range, string> = { t: "Today", w: "This week", m: "This month", a: "All time" };

function bounds(now: number): Record<Range, number> {
  const t = localTime(now);
  const dayStart = now - t.secondOfDay;
  return { t: dayStart, w: dayStart - (t.weekday - 1) * DAY, m: dayStart - (t.day - 1) * DAY, a: 0 };
}

const dateOf = (epoch: number): string => {
  const t = localTime(epoch);
  return dateKey(t.year, t.month, t.day);
};

const num = (r: Row | null, key: string): number => Number(r?.[key] ?? 0);

async function count(db: Db, sql: string, ...values: unknown[]): Promise<number> {
  const r = await db.prepare(sql).bind(...values).first<Row>();
  return Number(r?.n ?? 0);
}

// ---------- screens ----------

async function dashboard(db: Db, now: number, range: Range): Promise<Screen> {
  const start = bounds(now)[range];
  const o = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(status = 'completed'), 0) AS done, COALESCE(SUM(status = 'cancelled'), 0) AS cancelled, " +
        "COALESCE(SUM(status NOT IN ('completed', 'cancelled')), 0) AS active, COUNT(DISTINCT customer_id) AS customers, " +
        "COALESCE(SUM(CASE WHEN status != 'cancelled' THEN subtotal_santim ELSE 0 END), 0) AS food, " +
        "COALESCE(SUM(CASE WHEN status != 'cancelled' THEN fee_santim ELSE 0 END), 0) AS fees, " +
        "COALESCE(SUM(total_santim), 0) AS received, " +
        "COALESCE(SUM(CASE WHEN payment_status = 'refund_pending' THEN total_santim ELSE 0 END), 0) AS refund_pending, " +
        "COALESCE(SUM(CASE WHEN payment_status = 'refunded' THEN total_santim ELSE 0 END), 0) AS refunded " +
        "FROM orders WHERE created_at >= ?",
    )
    .bind(start)
    .first<Row>();
  const waiting = await count(db, "SELECT COUNT(*) AS n FROM checkout_sessions WHERE status = 'under_verification'");

  const text = [
    `📊 Dashboard — ${RANGE_LABEL[range]}`,
    "(Addis Ababa days. The week starts on Monday.)",
    "",
    `Orders: ${num(o, "n")}`,
    `  Completed: ${num(o, "done")} · Cancelled: ${num(o, "cancelled")} · In progress: ${num(o, "active")}`,
    `Different customers who ordered: ${num(o, "customers")}`,
    `Payments waiting to be checked (right now): ${waiting}`,
    "",
    "Money recorded for orders in this period:",
    `Food sales (cancelled orders left out): ${formatEtb(num(o, "food"))}`,
    `Delivery fees (cancelled orders left out): ${formatEtb(num(o, "fees"))}`,
    `Verified payments received: ${formatEtb(num(o, "received"))}`,
    `Refunds pending: ${formatEtb(num(o, "refund_pending"))}`,
    `Refunded: ${formatEtb(num(o, "refunded"))}`,
    "",
    "These are totals recorded by the bot. They are not profit, and they don't replace your bank statement.",
  ].join("\n");

  const ranges = (["t", "w", "m", "a"] as Range[]).map((r) => ({
    text: `${r === range ? "✅ " : ""}${r === "t" ? "Today" : r === "w" ? "Week" : r === "m" ? "Month" : "All"}`,
    data: `a:db:${r}`,
  }));
  return {
    text,
    buttons: [
      ranges,
      [{ text: "📈 Customer Statistics", data: "a:stats" }],
      [{ text: "👥 All-Time Customers", data: "a:customers" }],
      [{ text: "📦 Manage Orders", data: "a:orders" }, { text: "💳 Payments", data: "a:pay" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function statistics(db: Db, now: number): Promise<Screen> {
  const b = bounds(now);
  const registered = await count(db, "SELECT COUNT(*) AS n FROM (SELECT telegram_user_id FROM bot_users UNION SELECT telegram_user_id FROM customers)");
  const startedCheckout = await count(db, "SELECT COUNT(*) AS n FROM customers");
  const everOrdered = await count(db, "SELECT COUNT(DISTINCT customer_id) AS n FROM orders");
  const completedCustomers = await count(db, "SELECT COUNT(DISTINCT customer_id) AS n FROM orders WHERE status = 'completed'");
  const cancelledOnly = await count(
    db,
    "SELECT COUNT(*) AS n FROM (SELECT customer_id FROM orders GROUP BY customer_id HAVING SUM(status != 'cancelled') = 0)",
  );
  const repeat = await count(
    db,
    "SELECT COUNT(*) AS n FROM (SELECT customer_id FROM orders WHERE status = 'completed' GROUP BY customer_id HAVING COUNT(*) >= 2)",
  );
  const unique = (since: number) => count(db, "SELECT COUNT(DISTINCT customer_id) AS n FROM orders WHERE created_at >= ?", since);

  // New customers per week, by the week of their first order (last 8 weeks).
  const { results } = await db.prepare("SELECT MIN(created_at) AS first FROM orders GROUP BY customer_id").all<Row>();
  const buckets = new Array<number>(8).fill(0);
  for (const r of results) {
    const t = localTime(Number(r.first));
    const weekStart = Number(r.first) - t.secondOfDay - (t.weekday - 1) * DAY;
    const index = Math.round((b.w - weekStart) / (7 * DAY));
    if (index >= 0 && index < 8) buckets[index] += 1;
  }
  const growth: string[] = [];
  for (let i = 7; i >= 0; i--) growth.push(`Week of ${dateOf(b.w - i * 7 * DAY)}: ${buckets[i]} new`);

  return {
    text: [
      "📈 Customer Statistics",
      "",
      `Registered bot users (pressed Start): ${registered}`,
      `Started checkout: ${startedCheckout}`,
      `Placed at least one order: ${everOrdered}`,
      `  with a completed order: ${completedCustomers}`,
      `  cancelled-only (every order cancelled): ${cancelledOnly}`,
      `Repeat customers (2+ completed orders): ${repeat}`,
      "",
      "Different customers who ordered:",
      `Today: ${await unique(b.t)} · This week: ${await unique(b.w)} · This month: ${await unique(b.m)}`,
      "",
      "Growth (new customers, by the week of their first order):",
      ...growth,
    ].join("\n"),
    buttons: [[{ text: "👥 All-Time Customers", data: "a:customers" }], [{ text: "📊 Dashboard", data: "a:dash" }], [ADMIN_PANEL_BUTTON]],
  };
}

type Summary = { id: number; name: string; orders: number; completed: number; spent: number };

const SUMMARY_SQL =
  "SELECT c.telegram_user_id AS id, c.name AS name, COUNT(o.id) AS orders, " +
  "COALESCE(SUM(o.status = 'completed'), 0) AS completed, " +
  "COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total_santim ELSE 0 END), 0) AS spent, MAX(o.created_at) AS last_order " +
  "FROM customers c JOIN orders o ON o.customer_id = c.telegram_user_id";

const toSummary = (r: Row): Summary => ({
  id: Number(r.id), name: String(r.name), orders: Number(r.orders), completed: Number(r.completed), spent: Number(r.spent),
});

const summaryButton = (c: Summary): Button[] => [
  { text: `${c.name} — ${c.orders} order${c.orders === 1 ? "" : "s"} — ${formatEtb(c.spent)}`, data: `a:cu:${c.id}` },
];

async function customersScreen(db: Db, page: number): Promise<Screen> {
  const total = await count(db, "SELECT COUNT(DISTINCT customer_id) AS n FROM orders");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const { results } = await db
    .prepare(`${SUMMARY_SQL} GROUP BY c.telegram_user_id ORDER BY last_order DESC, c.telegram_user_id LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE, safePage * PAGE_SIZE)
    .all<Row>();
  const nav: Button[] = [];
  if (safePage > 0) nav.push({ text: "⬅ Previous", data: `a:cp:${safePage - 1}` });
  if ((safePage + 1) * PAGE_SIZE < total) nav.push({ text: "Next ➡", data: `a:cp:${safePage + 1}` });
  return {
    text:
      `👥 All-Time Customers\n\nCustomers who placed at least one order: ${total}\n` +
      `${total === 0 ? "None yet." : `Page ${safePage + 1} of ${pages}, most recent first. Tap a customer for details.`}`,
    buttons: [
      ...results.map((r) => summaryButton(toSummary(r))),
      ...(nav.length ? [nav] : []),
      [{ text: "🔎 Search", data: "a:cs" }, { text: "📈 Statistics", data: "a:stats" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function customerDetail(db: Db, id: number): Promise<Screen | null> {
  const c = await db
    .prepare("SELECT c.name AS name, c.phone AS phone, b.username AS username FROM customers c LEFT JOIN bot_users b ON b.telegram_user_id = c.telegram_user_id WHERE c.telegram_user_id = ?")
    .bind(id)
    .first<Row>();
  if (!c) return null;
  const a = await db
    .prepare(
      "SELECT COUNT(*) AS orders, COALESCE(SUM(status = 'completed'), 0) AS done, COALESCE(SUM(status = 'cancelled'), 0) AS cancelled, " +
        "COALESCE(SUM(status NOT IN ('completed', 'cancelled')), 0) AS active, " +
        "COALESCE(SUM(CASE WHEN status = 'completed' THEN total_santim ELSE 0 END), 0) AS spent, MIN(created_at) AS first, MAX(created_at) AS last " +
        "FROM orders WHERE customer_id = ?",
    )
    .bind(id)
    .first<Row>();
  const recent = await db
    .prepare("SELECT id, status, total_santim FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 10")
    .bind(id)
    .all<Row>();
  const orders = num(a, "orders");
  const text = [
    `👤 ${String(c.name)}`,
    `Telegram ID: ${id}`,
    `Username: ${c.username ? `@${String(c.username)}` : "not available"}`,
    `Phone: ${c.phone ? String(c.phone) : "not shared"}`,
    "",
    `Orders: ${orders} (completed ${num(a, "done")}, cancelled ${num(a, "cancelled")}, in progress ${num(a, "active")})`,
    `Spent on completed orders: ${formatEtb(num(a, "spent"))}`,
    orders > 0 ? `First order: ${dateTimeText(num(a, "first"))}` : "",
    orders > 0 ? `Latest order: ${dateTimeText(num(a, "last"))}` : "",
    "",
    orders > 0 ? "Recent orders (tap one):" : "No orders yet.",
  ]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");
  return {
    text,
    buttons: [
      ...recent.results.map((r) => [
        {
          text: `${STATUS_ICON[String(r.status) as OrderStatus]} ${orderNumber(Number(r.id))} — ${formatEtb(Number(r.total_santim))} — ${STATUS_LABEL[String(r.status) as OrderStatus]}`,
          data: `a:oo:${Number(r.id)}`,
        },
      ]),
      [{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${id}` }],
      [{ text: "⬅ All-Time Customers", data: "a:customers" }],
    ],
  };
}

async function searchResults(db: Db, query: string): Promise<Screen> {
  const q = query.trim().replace(/^@/, "");
  const id = /^\d{1,15}$/.test(q) ? Number(q) : -1;
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { results } = await db
    .prepare(
      `${SUMMARY_SQL} LEFT JOIN bot_users b ON b.telegram_user_id = c.telegram_user_id ` +
        "WHERE c.telegram_user_id = ? OR c.name LIKE ? ESCAPE '\\' OR b.username LIKE ? ESCAPE '\\' " +
        "GROUP BY c.telegram_user_id ORDER BY last_order DESC LIMIT ?",
    )
    .bind(id, like, like, PAGE_SIZE)
    .all<Row>();
  return {
    text: results.length === 0 ? `🔎 No customer who has ordered matches "${q}".` : `🔎 Customers matching "${q}":`,
    buttons: [
      ...results.map((r) => summaryButton(toSummary(r))),
      [{ text: "🔎 Search again", data: "a:cs" }],
      [{ text: "⬅ All-Time Customers", data: "a:customers" }],
    ],
  };
}

function reportsScreen(): Screen {
  return {
    text: "📄 Reports & History\n\nThe customer export has only IDs, order counts, spending and dates. It has no names, phone numbers or locations.",
    buttons: [
      [{ text: "📄 Export customers (CSV)", data: "a:rx" }],
      [{ text: "🕘 Recent admin actions", data: "a:rl" }],
      [{ text: "📊 Dashboard", data: "a:dash" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function auditScreen(db: Db): Promise<Screen> {
  const { results } = await db
    .prepare("SELECT at, actor_telegram_id, action FROM audit_log ORDER BY id DESC LIMIT 15")
    .all<Row>();
  return {
    text:
      "🕘 Recent admin actions (newest first)\n\n" +
      (results.length === 0 ? "None yet." : results.map((r) => `${dateTimeText(Number(r.at))}\n  ${String(r.action)} · by ${Number(r.actor_telegram_id)}`).join("\n")),
    buttons: [[{ text: "⬅ Reports & History", data: "a:reports" }]],
  };
}

// ---------- buttons ----------

export async function handleCustomersCallback(db: Db, adminId: number, data: string, now: number): Promise<CustomersResult | null> {
  if (data === "a:dash") {
    await clearState(db, adminId);
    return { screen: await dashboard(db, now, "t") };
  }
  let m = /^a:db:([twma])$/.exec(data);
  if (m) return { screen: await dashboard(db, now, m[1] as Range) };

  if (data === "a:stats") return { screen: await statistics(db, now) };
  if (data === "a:customers") {
    await clearState(db, adminId);
    return { screen: await customersScreen(db, 0) };
  }
  m = /^a:cp:(\d{1,6})$/.exec(data);
  if (m) return { screen: await customersScreen(db, Number(m[1])) };

  m = /^a:cu:(\d{1,15})$/.exec(data);
  if (m) {
    const screen = await customerDetail(db, Number(m[1]));
    return screen ? { screen } : { screen: await customersScreen(db, 0), toast: "That customer was not found." };
  }

  if (data === "a:cs") {
    await setState(db, adminId, { step: "cust_search" }, now);
    return {
      screen: {
        text: "🔎 Search customers\n\nType part of a name, a Telegram username, or a Telegram ID. Only customers who have placed an order are searched.",
        buttons: [[CANCEL]],
      },
    };
  }

  if (data === "a:reports") {
    await clearState(db, adminId);
    return { screen: reportsScreen() };
  }
  if (data === "a:rl") return { screen: await auditScreen(db) };
  if (data === "a:rx") {
    await setState(db, adminId, { step: "confirm", action: { type: "export_customers" } }, now);
    return {
      screen: confirmScreen(
        "Export the customer list as a CSV file?\n\nIt contains Telegram IDs, order counts, spending and dates (no names, phones or locations). It will be sent to this chat only, and the export is recorded in the audit log.\n\nTelegram chats are not end-to-end encrypted, so keep the file private.",
      ),
    };
  }
  return null;
}

// ---------- text typed by the admin ----------

export async function handleCustomersText(db: Db, adminId: number, state: AdminState, text: string): Promise<Screen | null> {
  if (state.step !== "cust_search") return null;
  if (text.trim().length === 0 || [...text].length > 60) {
    return { text: "Please type between 1 and 60 characters, or tap Cancel.", buttons: [[CANCEL]] };
  }
  await clearState(db, adminId);
  return searchResults(db, text);
}

// ---------- the export ----------

const money = (s: number) => `${Math.floor(s / 100)}.${String(s % 100).padStart(2, "0")}`;

export async function applyCustomersAction(db: Db, adminId: number, _action: CustomersAction, now: number): Promise<Outcome> {
  const { results } = await db
    .prepare(
      "SELECT customer_id, COUNT(*) AS orders, COALESCE(SUM(status = 'completed'), 0) AS done, COALESCE(SUM(status = 'cancelled'), 0) AS cancelled, " +
        "COALESCE(SUM(CASE WHEN status = 'completed' THEN total_santim ELSE 0 END), 0) AS spent, MIN(created_at) AS first, MAX(created_at) AS last " +
        "FROM orders GROUP BY customer_id ORDER BY customer_id",
    )
    .all<Row>();
  const lines = [
    "customer_id,orders,completed_orders,cancelled_orders,spent_on_completed_etb,first_order_date,latest_order_date",
    ...results.map((r) =>
      [Number(r.customer_id), Number(r.orders), Number(r.done), Number(r.cancelled), money(Number(r.spent)), dateOf(Number(r.first)), dateOf(Number(r.last))].join(","),
    ),
  ];
  await db
    .prepare(AUDIT_SQL + "VALUES (?, ?, 'report.export_customers', 'customers', ?)")
    .bind(now, adminId, JSON.stringify({ rows: results.length }))
    .run();
  return {
    ok: true,
    message: `Exported ${results.length} customer${results.length === 1 ? "" : "s"}.`,
    screen: reportsScreen(),
    document: { filename: `zippy-customers-${dateOf(now)}.csv`, text: `${lines.join("\n")}\n` },
  };
}
