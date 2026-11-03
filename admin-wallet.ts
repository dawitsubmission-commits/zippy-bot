// ZIPPY admin tools for the wallet. Only reached for an admin (bot.ts checks the Telegram ID first).
// Everything here works on SIMULATED funds only. Live (real-money) mode is locked until written legal clearance.
// A deposit is credited only after the admin verifies it, and only once (the ledger's idempotency key guarantees it).

import {
  ADMIN_PANEL_BUTTON, AUDIT_SQL, CANCEL, clearState, confirmScreen, promptScreen, setState,
  type AdminState, type Notify, type Outcome, type WalletAction,
} from "./admin-state";
import { formatEtb } from "./cart";
import type { Db } from "./db";
import { dateTimeText } from "./orders";
import type { Button, Screen } from "./screens";
import {
  LEDGER_LABEL, MAX_DEPOSIT_SANTIM, SIM_BANNER, depositRef, getBalances, getWalletMode, ledgerLines, ledgerRef, parseAmount,
} from "./wallet";

type Row = Record<string, unknown>;
export type WalletResult = { screen?: Screen; toast?: string; alert?: boolean; notify?: Notify[] };

export const isWalletStep = (step: string): boolean => ["wallet_search", "wallet_adj_amount", "wallet_adj_reason"].includes(step);
export const isWalletAction = (action: { type: string }): action is WalletAction =>
  ["wallet_mode", "deposit_verify", "deposit_reject", "wallet_adjust"].includes(action.type);

const BACK_TO_WALLET: Button = { text: "⬅ Wallet Management", data: "a:wallet" };
const REJECT_REASONS: Record<string, string> = { n: "the receipt wasn't clear enough", w: "the amount didn't match" };
const PAGE = 8;

const MODE_TEXT: Record<string, string> = {
  off: "⏸ OFF (the wallet is not available to customers)",
  test: "🧪 TEST (simulated funds only)",
  live: "🔒 LIVE (locked)",
};

async function customerName(db: Db, id: number): Promise<string> {
  const r = await db.prepare("SELECT name FROM customers WHERE telegram_user_id = ?").bind(id).first<Row>();
  return r ? String(r.name) : `Customer ${id}`;
}

async function needTest(db: Db): Promise<WalletResult | null> {
  return (await getWalletMode(db)) === "test"
    ? null
    : { screen: await overview(db), toast: "Switch the wallet to TEST mode first (Wallet Controls).", alert: true };
}

// ---------- screens ----------

async function overview(db: Db): Promise<Screen> {
  const mode = await getWalletMode(db);
  const waiting = Number(
    (await db.prepare("SELECT COUNT(*) AS n FROM wallet_deposits WHERE status = 'under_verification'").first<Row>())?.n ?? 0,
  );
  return {
    text: `💰 Wallet Management\n\nMode: ${MODE_TEXT[mode]}\nDeposit requests waiting: ${waiting}\n\nAll amounts here are simulated test money.`,
    buttons: [
      [{ text: `📥 Deposit requests (${waiting})`, data: "a:wq" }],
      [{ text: "🔎 Search customer wallet", data: "a:ws" }],
      [{ text: "📜 Wallet transaction history", data: "a:wl" }],
      [{ text: "⚙️ Wallet Controls", data: "a:wc" }],
      [ADMIN_PANEL_BUTTON],
    ],
  };
}

async function controlsScreen(db: Db): Promise<Screen> {
  const mode = await getWalletMode(db);
  return {
    text:
      `⚙️ Wallet Controls\n\nMode: ${MODE_TEXT[mode]}\n\n` +
      "Real-money deposits: OFF\nReal-money wallet payments: OFF\nReal-money withdrawals: OFF\n" +
      "Limits, fees and processing times: not set yet\n\n" +
      "LIVE mode is locked. Real customer money must not be accepted, held or paid out until you hold written clearance from the National Bank of Ethiopia or a qualified lawyer.",
    buttons: [
      [mode === "test" ? { text: "⏸ Switch the wallet OFF", data: "a:wm:off" } : { text: "🧪 Switch to TEST mode (simulated)", data: "a:wm:test" }],
      [{ text: "🔒 Live mode (locked)", data: "a:wlive" }],
      [BACK_TO_WALLET],
    ],
  };
}

async function depositsScreen(db: Db): Promise<Screen> {
  const { results } = await db
    .prepare(
      "SELECT d.id, d.amount_santim, c.name FROM wallet_deposits d LEFT JOIN customers c ON c.telegram_user_id = d.customer_id " +
        "WHERE d.status = 'under_verification' ORDER BY d.submitted_at, d.id",
    )
    .all<Row>();
  return {
    text: `📥 Deposit requests\n\n${results.length === 0 ? "Nothing is waiting." : "Oldest first. Tap one to open it."}`,
    buttons: [
      ...results.map((r) => [{ text: `${depositRef(Number(r.id))} — ${formatEtb(Number(r.amount_santim))} — ${r.name ? String(r.name) : "customer"}`, data: `a:dp:${Number(r.id)}` }]),
      [BACK_TO_WALLET],
    ],
  };
}

async function depositDetail(db: Db, id: number): Promise<Screen | null> {
  const d = await db.prepare("SELECT * FROM wallet_deposits WHERE id = ?").bind(id).first<Row>();
  if (!d) return null;
  const c = await db.prepare("SELECT name, phone FROM customers WHERE telegram_user_id = ?").bind(Number(d.customer_id)).first<Row>();
  const status = String(d.status);
  const text = [
    `📥 Deposit ${depositRef(id)} — ${status.replaceAll("_", " ")}`,
    Number(d.simulated) === 1 ? SIM_BANNER : "",
    "",
    `Customer: ${c ? String(c.name) : `Customer ${Number(d.customer_id)}`}`,
    `Phone: ${c?.phone ? String(c.phone) : "not shared"}`,
    `Amount: ${formatEtb(Number(d.amount_santim))}`,
    `Method: ${String(d.method) === "cbe" ? "CBE" : "CBE Birr"}`,
    d.submitted_at ? `Submitted: ${dateTimeText(Number(d.submitted_at))}` : "",
    "",
    status === "under_verification" ? "The picture was sent to you when it arrived." : "",
  ]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
  const buttons: Button[][] = [];
  if (status === "under_verification") {
    buttons.push([{ text: "✅ Verify and credit", data: `a:dv:${id}` }], [{ text: "❌ Reject", data: `a:dx:${id}` }]);
  }
  buttons.push([{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${Number(d.customer_id)}` }], [{ text: "⬅ Deposit requests", data: "a:wq" }]);
  return { text, buttons };
}

async function walletDetail(db: Db, customerId: number): Promise<Screen | null> {
  const c = await db.prepare("SELECT name FROM customers WHERE telegram_user_id = ?").bind(customerId).first<Row>();
  if (!c) return null;
  const b = await getBalances(db, customerId, true);
  const lines = await ledgerLines(db, customerId, true, 5);
  return {
    text: [
      `💰 Wallet — ${String(c.name)}`,
      SIM_BANNER,
      `Telegram ID: ${customerId}`,
      "",
      `Available: ${formatEtb(b.available)}`,
      `Reserved: ${formatEtb(b.reserved)}`,
      `Total: ${formatEtb(b.total)}`,
      "",
      lines.length === 0 ? "No transactions yet." : "Latest transactions:",
      ...lines,
    ].join("\n"),
    buttons: [
      [{ text: "➕ Credit", data: `a:wa:${customerId}:c` }, { text: "➖ Debit", data: `a:wa:${customerId}:d` }],
      [{ text: "📞 Contact customer", data: "x:noop", url: `tg://user?id=${customerId}` }],
      [BACK_TO_WALLET],
    ],
  };
}

async function historyScreen(db: Db): Promise<Screen> {
  const { results } = await db
    .prepare(
      "SELECT l.id, l.type, l.delta_available, l.delta_reserved, l.created_at, l.customer_id, c.name FROM wallet_ledger l " +
        "LEFT JOIN customers c ON c.telegram_user_id = l.customer_id WHERE l.simulated = 1 ORDER BY l.id DESC LIMIT 15",
    )
    .all<Row>();
  const lines = results.map((r) => {
    const shown = Number(r.delta_available) !== 0 ? Number(r.delta_available) : Number(r.delta_reserved);
    return `${ledgerRef(Number(r.id))} · ${LEDGER_LABEL[String(r.type)] ?? String(r.type)} · ${shown >= 0 ? "+" : "−"}${formatEtb(Math.abs(shown))}\n   ${r.name ? String(r.name) : `Customer ${Number(r.customer_id)}`} · ${dateTimeText(Number(r.created_at))}`;
  });
  return {
    text: `📜 Wallet transaction history (latest 15)\n${SIM_BANNER}\n\n${lines.length === 0 ? "No transactions yet." : lines.join("\n\n")}`,
    buttons: [[BACK_TO_WALLET]],
  };
}

// ---------- buttons ----------

export async function handleWalletAdminCallback(db: Db, adminId: number, data: string, now: number): Promise<WalletResult | null> {
  if (data === "a:wallet") {
    await clearState(db, adminId);
    return { screen: await overview(db) };
  }
  if (data === "a:wc") return { screen: await controlsScreen(db) };
  if (data === "a:wlive") return { toast: "Live mode is locked. Real money stays off until you hold written legal clearance.", alert: true };

  let m = /^a:wm:(off|test)$/.exec(data);
  if (m) {
    await setState(db, adminId, { step: "confirm", action: { type: "wallet_mode", mode: m[1] as "off" | "test" } }, now);
    return {
      screen: confirmScreen(
        m[1] === "test"
          ? "Switch the wallet to TEST mode?\n\nCustomers will see My Wallet with SIMULATED funds only (clearly labelled). No real money moves."
          : "Switch the wallet OFF?\n\nCustomers will see \"The wallet isn't available yet\". Test balances are kept.",
      ),
    };
  }

  if (data === "a:wq") return { screen: await depositsScreen(db) };
  if (data === "a:wl") return { screen: await historyScreen(db) };

  m = /^a:dp:(\d{1,9})$/.exec(data);
  if (m) {
    const screen = await depositDetail(db, Number(m[1]));
    return screen ? { screen } : { screen: await depositsScreen(db), toast: "That deposit was not found." };
  }

  m = /^a:dv:(\d{1,9})$/.exec(data);
  if (m) {
    const blocked = await needTest(db);
    if (blocked) return blocked;
    const d = await db.prepare("SELECT customer_id, amount_santim, status FROM wallet_deposits WHERE id = ?").bind(Number(m[1])).first<Row>();
    if (!d || String(d.status) !== "under_verification") return { screen: await depositsScreen(db), toast: "That deposit isn't waiting to be checked.", alert: true };
    await setState(db, adminId, { step: "confirm", action: { type: "deposit_verify", depositId: Number(m[1]) } }, now);
    return {
      screen: confirmScreen(
        `Credit ${formatEtb(Number(d.amount_santim))} (SIMULATED test money) to ${await customerName(db, Number(d.customer_id))}'s wallet?\n\nIn live mode you would only do this after checking your REAL account.`,
      ),
    };
  }

  m = /^a:dx:(\d{1,9})$/.exec(data);
  if (m) {
    const d = await db.prepare("SELECT status FROM wallet_deposits WHERE id = ?").bind(Number(m[1])).first<Row>();
    if (!d || String(d.status) !== "under_verification") return { screen: await depositsScreen(db), toast: "That deposit isn't waiting to be checked.", alert: true };
    return {
      screen: {
        text: `Why are you rejecting deposit ${depositRef(Number(m[1]))}? The customer will be told.`,
        buttons: [
          [{ text: "Receipt not clear", data: `a:dr:${m[1]}:n` }],
          [{ text: "Wrong amount", data: `a:dr:${m[1]}:w` }],
          [{ text: "⬅ Back", data: `a:dp:${m[1]}` }],
        ],
      },
    };
  }
  m = /^a:dr:(\d{1,9}):([nw])$/.exec(data);
  if (m) {
    await setState(db, adminId, { step: "confirm", action: { type: "deposit_reject", depositId: Number(m[1]), reason: REJECT_REASONS[m[2]] } }, now);
    return { screen: confirmScreen(`Reject deposit ${depositRef(Number(m[1]))}?\n\nThe customer will be told that ${REJECT_REASONS[m[2]]}.`) };
  }

  if (data === "a:ws") {
    const blocked = await needTest(db);
    if (blocked) return blocked;
    await setState(db, adminId, { step: "wallet_search" }, now);
    return { screen: promptScreen("🔎 Search customer wallet\n\nType part of a name, a Telegram username, or a Telegram ID.") };
  }
  m = /^a:wu:(\d{1,15})$/.exec(data);
  if (m) {
    const blocked = await needTest(db);
    if (blocked) return blocked;
    const screen = await walletDetail(db, Number(m[1]));
    return screen ? { screen } : { screen: await overview(db), toast: "That customer was not found." };
  }

  m = /^a:wa:(\d{1,15}):([cd])$/.exec(data);
  if (m) {
    const blocked = await needTest(db);
    if (blocked) return blocked;
    const direction = m[2] === "c" ? "credit" : "debit";
    await setState(db, adminId, { step: "wallet_adj_amount", customerId: Number(m[1]), direction }, now);
    return {
      screen: promptScreen(`${direction === "credit" ? "➕ Credit" : "➖ Debit"} ${await customerName(db, Number(m[1]))}'s wallet (SIMULATED)\n\nType the amount in ETB, for example 100.`),
    };
  }
  return null;
}

// ---------- typed text ----------

export async function handleWalletAdminText(db: Db, adminId: number, state: AdminState, text: string, now: number): Promise<Screen | null> {
  if (state.step === "wallet_search") {
    await clearState(db, adminId);
    const q = text.trim().replace(/^@/, "");
    if (q.length === 0 || [...q].length > 60) return { text: "Please type between 1 and 60 characters.", buttons: [[BACK_TO_WALLET]] };
    const id = /^\d{1,15}$/.test(q) ? Number(q) : -1;
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const { results } = await db
      .prepare(
        "SELECT c.telegram_user_id AS id, c.name AS name FROM customers c LEFT JOIN bot_users b ON b.telegram_user_id = c.telegram_user_id " +
          "WHERE c.telegram_user_id = ? OR c.name LIKE ? ESCAPE '\\' OR b.username LIKE ? ESCAPE '\\' LIMIT ?",
      )
      .bind(id, like, like, PAGE)
      .all<Row>();
    return {
      text: results.length === 0 ? `🔎 No customer matches "${q}".` : `🔎 Customers matching "${q}":`,
      buttons: [...results.map((r) => [{ text: String(r.name), data: `a:wu:${Number(r.id)}` }]), [BACK_TO_WALLET]],
    };
  }

  if (state.step === "wallet_adj_amount") {
    const amount = parseAmount(text);
    if (amount === null || amount <= 0 || amount > MAX_DEPOSIT_SANTIM) {
      return { text: "That isn't a valid amount. Type a number like 100 or 99.50, or tap Cancel.", buttons: [[CANCEL]] };
    }
    await setState(db, adminId, { step: "wallet_adj_reason", customerId: state.customerId, direction: state.direction, amount }, now);
    return promptScreen("Now type the REASON (up to 120 characters, one line). The customer will SEE it in their history.");
  }

  if (state.step === "wallet_adj_reason") {
    const reason = text.trim();
    if ([...reason].length < 3 || [...reason].length > 120 || /[\u0000-\u001F\u007F\u2028\u2029]/.test(reason) || reason.startsWith("/")) {
      return { text: "Please give a reason of 3 to 120 characters on one line, or tap Cancel.", buttons: [[CANCEL]] };
    }
    const name = await customerName(db, state.customerId);
    if (state.direction === "debit") {
      const b = await getBalances(db, state.customerId, true);
      if (b.available < state.amount) {
        await clearState(db, adminId);
        return { text: `${name} only has ${formatEtb(b.available)} available. A debit can't take the balance below zero. Nothing was changed.`, buttons: [[BACK_TO_WALLET]] };
      }
    }
    const key = `adj:${crypto.randomUUID()}`;
    await setState(
      db, adminId,
      { step: "confirm", action: { type: "wallet_adjust", customerId: state.customerId, direction: state.direction, amount: state.amount, reason, key } },
      now,
    );
    return confirmScreen(
      `${state.direction === "credit" ? "Credit" : "Debit"} ${formatEtb(state.amount)} (SIMULATED) ${state.direction === "credit" ? "to" : "from"} ${name}'s wallet?\n\nReason the customer will see:\n“${reason}”`,
    );
  }
  return null;
}

// ---------- applying a confirmed change (all or nothing) ----------

export async function applyWalletAction(db: Db, adminId: number, action: WalletAction, now: number): Promise<Outcome> {
  const back = async (ok: boolean, message: string, notify?: Notify[]): Promise<Outcome> => ({ ok, message, screen: await overview(db), notify });

  if (action.type === "wallet_mode") {
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'wallet.mode', 'settings', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'wallet_mode' AND value != ?)")
        .bind(now, adminId, JSON.stringify({ to: action.mode }), action.mode),
      db.prepare("UPDATE settings SET value = ? WHERE key = 'wallet_mode' AND value != ?").bind(action.mode, action.mode),
    ]);
    return (await getWalletMode(db)) === action.mode
      ? { ok: true, message: action.mode === "test" ? "Wallet is in TEST mode (simulated funds)." : "Wallet is OFF.", screen: await controlsScreen(db) }
      : back(false, "Nothing was changed.");
  }

  if (action.type === "deposit_reject") {
    const d = await db.prepare("SELECT customer_id, amount_santim, status FROM wallet_deposits WHERE id = ?").bind(action.depositId).first<Row>();
    if (!d || String(d.status) !== "under_verification") return back(false, "That deposit was already handled. Nothing was changed.");
    await db.batch([
      db
        .prepare(AUDIT_SQL + "SELECT ?, ?, 'wallet.deposit_rejected', ?, ? WHERE EXISTS (SELECT 1 FROM wallet_deposits WHERE id = ? AND status = 'under_verification')")
        .bind(now, adminId, `deposit:${action.depositId}`, JSON.stringify({ amount: Number(d.amount_santim) }), action.depositId),
      db
        .prepare("UPDATE wallet_deposits SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'under_verification'")
        .bind(action.reason, adminId, now, action.depositId),
    ]);
    return back(true, `Deposit ${depositRef(action.depositId)} rejected.`, [
      { chatId: Number(d.customer_id), text: `❌ Your SIMULATED deposit ${depositRef(action.depositId)} was not accepted: ${action.reason}.\n${SIM_BANNER}` },
    ]);
  }

  if (action.type === "deposit_verify") {
    const d = await db.prepare("SELECT customer_id, amount_santim, status FROM wallet_deposits WHERE id = ?").bind(action.depositId).first<Row>();
    if (!d || String(d.status) !== "under_verification") return back(false, "That deposit was already handled. Nothing was changed.");
    if ((await getWalletMode(db)) !== "test") return back(false, "The wallet is not in TEST mode. Nothing was changed.");
    const id = action.depositId;
    try {
      await db.batch([
        db.prepare("UPDATE wallet_deposits SET status = 'verified', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'under_verification'").bind(adminId, now, id),
        db
          .prepare("INSERT OR IGNORE INTO wallets (customer_id, simulated, available_santim, reserved_santim, created_at, updated_at) SELECT customer_id, simulated, 0, 0, ?, ? FROM wallet_deposits WHERE id = ?")
          .bind(now, now, id),
        db
          .prepare(
            "UPDATE wallets SET available_santim = available_santim + (SELECT amount_santim FROM wallet_deposits WHERE id = ?), updated_at = ? " +
              "WHERE customer_id = (SELECT customer_id FROM wallet_deposits WHERE id = ?) AND simulated = (SELECT simulated FROM wallet_deposits WHERE id = ?) " +
              "AND EXISTS (SELECT 1 FROM wallet_deposits WHERE id = ? AND status = 'verified')",
          )
          .bind(id, now, id, id, id),
        // The idempotency key is UNIQUE: if this deposit was already credited, this statement fails and the whole step is undone.
        db
          .prepare(
            "INSERT INTO wallet_ledger (customer_id, simulated, type, delta_available, delta_reserved, available_after, reserved_after, description, ref_type, ref_id, idempotency_key, actor_telegram_id, created_at) " +
              "SELECT d.customer_id, d.simulated, 'deposit', d.amount_santim, 0, w.available_santim, w.reserved_santim, ?, 'deposit', d.id, ?, ?, ? " +
              "FROM wallet_deposits d JOIN wallets w ON w.customer_id = d.customer_id AND w.simulated = d.simulated WHERE d.id = ? AND d.status = 'verified'",
          )
          .bind(`Deposit ${depositRef(id)} (simulated)`, `deposit:${id}`, adminId, now, id),
        db
          .prepare(AUDIT_SQL + "VALUES (?, ?, 'wallet.deposit_verified', ?, ?)")
          .bind(now, adminId, `deposit:${id}`, JSON.stringify({ amount: Number(d.amount_santim), simulated: true })),
      ]);
    } catch {
      return back(false, "That deposit was already credited, or something went wrong. Nothing was changed.");
    }
    const b = await getBalances(db, Number(d.customer_id), true);
    return back(true, `Deposit ${depositRef(id)} credited (simulated).`, [
      {
        chatId: Number(d.customer_id),
        text: `✅ Your SIMULATED deposit ${depositRef(id)} of ${formatEtb(Number(d.amount_santim))} was credited.\n${SIM_BANNER}\nAvailable now: ${formatEtb(b.available)}`,
      },
    ]);
  }

  // wallet_adjust
  if ((await getWalletMode(db)) !== "test") return back(false, "The wallet is not in TEST mode. Nothing was changed.");
  const signed = action.direction === "credit" ? action.amount : -action.amount;
  try {
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO wallets (customer_id, simulated, available_santim, reserved_santim, created_at, updated_at) VALUES (?, 1, 0, 0, ?, ?)")
        .bind(action.customerId, now, now),
      // A debit larger than the balance breaks the "never below zero" rule, so the database undoes everything.
      db
        .prepare("UPDATE wallets SET available_santim = available_santim + ?, updated_at = ? WHERE customer_id = ? AND simulated = 1")
        .bind(signed, now, action.customerId),
      db
        .prepare(
          "INSERT INTO wallet_ledger (customer_id, simulated, type, delta_available, delta_reserved, available_after, reserved_after, description, ref_type, ref_id, idempotency_key, actor_telegram_id, created_at) " +
            "SELECT w.customer_id, 1, ?, ?, 0, w.available_santim, w.reserved_santim, ?, 'adjustment', NULL, ?, ?, ? FROM wallets w WHERE w.customer_id = ? AND w.simulated = 1",
        )
        .bind(action.direction === "credit" ? "adjustment_credit" : "adjustment_debit", signed, action.reason, action.key, adminId, now, action.customerId),
      db
        .prepare(AUDIT_SQL + "VALUES (?, ?, 'wallet.adjustment', ?, ?)")
        .bind(now, adminId, `wallet:${action.customerId}`, JSON.stringify({ direction: action.direction, amount: action.amount, simulated: true })),
    ]);
  } catch {
    return back(false, "Not done: the balance can't go below zero, or this was already applied. Nothing was changed.");
  }
  const b = await getBalances(db, action.customerId, true);
  return {
    ok: true,
    message: `${action.direction === "credit" ? "Credited" : "Debited"} ${formatEtb(action.amount)} (simulated).`,
    screen: (await walletDetail(db, action.customerId)) ?? (await overview(db)),
    notify: [
      {
        chatId: action.customerId,
        text:
          `💰 Your SIMULATED wallet was ${action.direction === "credit" ? "credited" : "debited"} ${formatEtb(action.amount)}.\n` +
          `Reason: ${action.reason}\n${SIM_BANNER}\nAvailable now: ${formatEtb(b.available)}`,
      },
    ],
  };
}
