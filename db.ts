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
