// Database helpers for Cloudflare D1 (which is SQLite).

// Only the small part of the D1 API that we use. Keeping it small lets us test with a fake.
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface Db {
  prepare(sql: string): Stmt;
  batch(statements: Stmt[]): Promise<unknown[]>;
}

export type Migration = { id: string; statements: string[] };

// Add new migrations to the END of this list. Never edit one that has already run.
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_processed_updates",
    statements: [
      // Remembers which Telegram updates we already handled, so retries never repeat work.
      "CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL)",
    ],
  },
  {
    id: "0002_shop",
    statements: [
      "CREATE TABLE cafeterias (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)), sort_order INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE menu_items (id INTEGER PRIMARY KEY, cafeteria_id INTEGER NOT NULL REFERENCES cafeterias(id), name TEXT NOT NULL, price_santim INTEGER NOT NULL CHECK (price_santim > 0), available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)), archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), sort_order INTEGER NOT NULL DEFAULT 0)",
      "CREATE INDEX idx_menu_items_cafeteria ON menu_items (cafeteria_id)",
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      // 1000 santim = ETB 10 per portion. Money is stored as whole santim (100 santim = 1 ETB).
      "INSERT INTO settings (key, value) VALUES ('delivery_fee_per_portion_santim', '1000')",
      "CREATE TABLE carts (telegram_user_id INTEGER PRIMARY KEY, cafeteria_id INTEGER NOT NULL REFERENCES cafeterias(id), updated_at INTEGER NOT NULL)",
      "CREATE TABLE cart_items (telegram_user_id INTEGER NOT NULL, menu_item_id INTEGER NOT NULL REFERENCES menu_items(id), quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99), PRIMARY KEY (telegram_user_id, menu_item_id))",
      "INSERT INTO cafeterias (id, name, active, sort_order) VALUES (1, 'ዘሩ ምግብ ቤት', 1, 1), (2, 'ኤማንዳ', 0, 2)",
      // Exact names and prices supplied by the owner (150 ETB = 15000 santim).
      "INSERT INTO menu_items (id, cafeteria_id, name, price_santim, sort_order) VALUES (1, 1, 'ሶሲ ስልስ', 15000, 1), (2, 1, 'ፓስታ በእንቁላል', 15000, 2), (3, 1, 'እንቁላል ስልስ', 15000, 3), (4, 1, 'ምስር ወጥ', 15000, 4), (5, 1, 'ሙሉ ፍርፍር', 13000, 5), (6, 1, 'ግማሽ ፍርፍር', 12000, 6), (7, 1, 'ፓስታ ባትክልት', 12000, 7), (8, 1, 'ቲማቲም ለብለብ', 12000, 8), (9, 1, 'ፓስታ በስጎ', 12000, 9), (10, 1, 'ድንች ወጥ', 12000, 10), (11, 1, 'ሽሮ ፈሰስ', 12000, 11)",
    ],
  },
  {
    id: "0003_admin",
    statements: [
      // A permanent record of what the admin changed, and when. Rows are only ever added.
      "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_telegram_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL)",
      // Remembers what the admin is in the middle of (for example: "typing a new price").
      "CREATE TABLE admin_state (telegram_user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      // No two visible foods in a cafeteria may share the exact same name.
      "CREATE UNIQUE INDEX uq_menu_item_name ON menu_items (cafeteria_id, name) WHERE archived = 0",
    ],
  },
  {
    id: "0004_schedule",
    statements: [
      // Ordering windows, as normal minutes of the day (480 = 08:00). The close moment is NOT included.
      "CREATE TABLE schedule_windows (id INTEGER PRIMARY KEY, name TEXT NOT NULL, open_minute INTEGER NOT NULL CHECK (open_minute >= 0 AND open_minute < 1440), close_minute INTEGER NOT NULL CHECK (close_minute > open_minute AND close_minute <= 1440), sort_order INTEGER NOT NULL DEFAULT 0)",
      // PROVISIONAL (owner to confirm): Lunch 2:00-5:30 and Dinner 10:00-11:45 on the Ethiopian clock.
      "INSERT INTO schedule_windows (id, name, open_minute, close_minute, sort_order) VALUES (1, 'Lunch', 480, 690, 1), (2, 'Dinner', 960, 1065, 2)",
      // 1 = Monday ... 7 = Sunday. Weekends are closed by default.
      "INSERT INTO settings (key, value) VALUES ('open_weekdays', '1,2,3,4,5')",
      // Whether admin screens also show the normal 24-hour time beside the Ethiopian clock.
      "INSERT INTO settings (key, value) VALUES ('admin_show_international', '1')",
      // Special closures and holidays (a date such as 2026-11-12 in Addis Ababa).
      "CREATE TABLE closures (date TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '')",
      // "Open now" / "Close now" with an end time. At most one row.
      "CREATE TABLE schedule_override (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL CHECK (mode IN ('open', 'closed')), until INTEGER NOT NULL, set_by INTEGER NOT NULL, set_at INTEGER NOT NULL)",
    ],
  },
  {
    id: "0005_checkout",
    statements: [
      // What we need to deliver: a name, and (if the owner requires it) a phone number shared through Telegram.
      "CREATE TABLE customers (telegram_user_id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, phone_verified INTEGER NOT NULL DEFAULT 0 CHECK (phone_verified IN (0, 1)), last_location TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      // Remembers which checkout step a customer is on (for example: "typing a dorm number").
      "CREATE TABLE customer_state (telegram_user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      // PROVISIONAL (owner to confirm): ask for a verified phone number before the first order. 1 = required.
      "INSERT INTO settings (key, value) VALUES ('require_phone', '1')",
    ],
  },
  {
    id: "0006_payments",
    statements: [
      // One row per payment attempt. The prices are locked here, so later menu or fee changes never change it.
      "CREATE TABLE checkout_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(telegram_user_id), cafeteria_id INTEGER NOT NULL REFERENCES cafeterias(id), method TEXT NOT NULL CHECK (method IN ('cbe', 'cbe_birr')), status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'under_verification', 'verified', 'rejected', 'expired', 'cancelled')), subtotal_santim INTEGER NOT NULL CHECK (subtotal_santim >= 0), fee_santim INTEGER NOT NULL CHECK (fee_santim >= 0), total_santim INTEGER NOT NULL CHECK (total_santim >= 0), portions INTEGER NOT NULL CHECK (portions >= 1), items_json TEXT NOT NULL, customer_name TEXT NOT NULL, location_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bank_reference TEXT, screenshot_file_id TEXT, screenshot_unique_id TEXT, submitted_at INTEGER)",
      // The same bank reference can never be used twice for a live or verified payment.
      "CREATE UNIQUE INDEX uq_session_reference ON checkout_sessions (method, bank_reference) WHERE bank_reference IS NOT NULL AND status IN ('awaiting_payment', 'under_verification', 'verified')",
      // A customer can have only one open payment at a time.
      "CREATE UNIQUE INDEX uq_session_open ON checkout_sessions (customer_id) WHERE status IN ('awaiting_payment', 'under_verification')",
    ],
  },
  {
    id: "0007_orders",
    statements: [
      // A confirmed order exists only after the admin has verified the payment. The order number is ZP-<id>,
      // and the id can never repeat (AUTOINCREMENT), so two orders can never share a number.
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL UNIQUE REFERENCES checkout_sessions(id), customer_id INTEGER NOT NULL, cafeteria_id INTEGER NOT NULL REFERENCES cafeterias(id), status TEXT NOT NULL CHECK (status IN ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')), payment_status TEXT NOT NULL CHECK (payment_status IN ('verified', 'refund_pending', 'refunded')), method TEXT NOT NULL, subtotal_santim INTEGER NOT NULL, fee_santim INTEGER NOT NULL, total_santim INTEGER NOT NULL, portions INTEGER NOT NULL, items_json TEXT NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT, location_json TEXT NOT NULL, bank_reference TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE INDEX idx_orders_customer ON orders (customer_id, id)",
      "CREATE INDEX idx_orders_status ON orders (status, id)",
      // Every change of an order's status: from, to, who and when.
      "CREATE TABLE order_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), from_status TEXT, to_status TEXT NOT NULL, actor_telegram_id INTEGER NOT NULL, at INTEGER NOT NULL)",
      // Who verified or rejected which payment, and when.
      "CREATE TABLE payment_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES checkout_sessions(id), event TEXT NOT NULL CHECK (event IN ('verified', 'rejected')), actor_telegram_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)",
    ],
  },
  {
    id: "0008_customers",
    statements: [
      // Everyone who pressed Start (for the "registered bot users" number). Username is optional and can change.
      "CREATE TABLE bot_users (telegram_user_id INTEGER PRIMARY KEY, username TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)",
      "CREATE INDEX idx_orders_created ON orders (created_at)",
    ],
  },
  {
    id: "0009_refunds",
    statements: [
      // The amount actually received for the order. total_santim is the order's current value (it can go down if part is refunded).
      "ALTER TABLE orders ADD COLUMN paid_santim INTEGER",
      "UPDATE orders SET paid_santim = total_santim WHERE paid_santim IS NULL",
      // One row per refund. Account details are kept only until the refund is finished, then erased.
      "CREATE TABLE refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), customer_id INTEGER NOT NULL, amount_santim INTEGER NOT NULL CHECK (amount_santim > 0), reason TEXT NOT NULL CHECK (reason IN ('cancelled', 'unavailable', 'changed')), status TEXT NOT NULL CHECK (status IN ('awaiting_details', 'pending', 'processing', 'refunded', 'declined')), method TEXT CHECK (method IN ('cbe', 'cbe_birr')), account_name TEXT, account_number TEXT, proof_file_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE INDEX idx_refunds_status ON refunds (status, id)",
      "CREATE INDEX idx_refunds_order ON refunds (order_id)",
    ],
  },
];

// Applies any migrations that have not run yet. Safe to run many times.
// Each migration and its record are applied together in one batch (all or nothing).
export async function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    .run();
  const applied: string[] = [];
  for (const m of migrations) {
    const done = await db.prepare("SELECT id FROM _migrations WHERE id = ?").bind(m.id).first();
    if (done) continue;
    const now = Math.floor(Date.now() / 1000);
    await db.batch([
      ...m.statements.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").bind(m.id, now),
    ]);
    applied.push(m.id);
  }
  return applied;
}

export async function schemaVersion(db: Db): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT id FROM _migrations ORDER BY id DESC LIMIT 1").first<{ id: string }>();
    return row ? row.id : null;
  } catch {
    return null; // table does not exist yet
  }
}

// Returns true the first time an update ID is seen, false for repeats.
export async function claimUpdate(db: Db, updateId: number, nowSeconds: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, received_at) VALUES (?, ?)")
    .bind(updateId, nowSeconds)
    .run();
  return result.meta?.changes === 1;
}

// If handling failed, forget the update so Telegram's retry can try again.
export async function releaseUpdate(db: Db, updateId: number): Promise<void> {
  await db.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run();
}
