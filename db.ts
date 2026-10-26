// Database helpers for Cloudflare D1 (which is SQLite).

// Only the small part of the D1 API that we use. Keeping it small lets us test with a fake.
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
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
