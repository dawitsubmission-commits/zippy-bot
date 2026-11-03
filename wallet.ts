// ZIPPY wallet, customer side.
// The wallet has three modes (an admin setting):
//   off  : the wallet isn't available (default)
//   test : everything works with SIMULATED funds only, and every screen says so
//   live : real money. LOCKED until the owner holds written legal clearance (not unlockable in this version)
// Balances are kept as whole santim. The database refuses a negative balance. Every money movement is one ledger row.

import { formatEtb } from "./cart";
import { clearState, getCustomer, getState, setState, type FlowResult, type User } from "./checkout";
import type { Db } from "./db";
import { dateTimeText } from "./orders";
import { CB, type Button, type Screen } from "./screens";

type Row = Record<string, unknown>;

export type WalletMode = "off" | "test" | "live";
export const SIM_BANNER = "🧪 SIMULATED FUNDS — this is not real money.";

// PROVISIONAL: how long a deposit request stays open. The maximum is only a typing-mistake guard (not a business limit).
export const DEPOSIT_SECONDS = 30 * 60;
export const MAX_DEPOSIT_SANTIM = 100_000 * 100;

export async function getWalletMode(db: Db): Promise<WalletMode> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'wallet_mode'").first<{ value: string }>();
  return r?.value === "test" || r?.value === "live" ? r.value : "off";
}

export const ledgerRef = (id: number): string => `ZW-${String(id).padStart(6, "0")}`;
export const depositRef = (id: number): string => `ZD-${String(id).padStart(6, "0")}`;

export const LEDGER_LABEL: Record<string, string> = {
  deposit: "Deposit",
  order_payment: "Order payment",
  order_refund: "Refund",
  withdrawal_reserve: "Withdrawal requested",
  withdrawal_release: "Withdrawal released",
  withdrawal_complete: "Withdrawal",
  withdrawal_fee: "Withdrawal fee",
  adjustment_credit: "Adjustment (credit)",
  adjustment_debit: "Adjustment (debit)",
  reversal: "Reversal",
};

export type Balances = { available: number; reserved: number; total: number };

export async function getBalances(db: Db, customerId: number, simulated: boolean): Promise<Balances> {
  const r = await db
    .prepare("SELECT available_santim, reserved_santim FROM wallets WHERE customer_id = ? AND simulated = ?")
    .bind(customerId, simulated ? 1 : 0)
    .first<Row>();
  const available = Number(r?.available_santim ?? 0);
  const reserved = Number(r?.reserved_santim ?? 0);
  return { available, reserved, total: available + reserved };
}

// "500" -> 50000, "99.5" -> 9950. Whole santim only.
export function parseAmount(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/^ETB\s*/i, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}

// The newest ledger rows as text lines (the reason is shown for admin adjustments).
export async function ledgerLines(db: Db, customerId: number, simulated: boolean, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT id, type, delta_available, delta_reserved, description, created_at FROM wallet_ledger WHERE customer_id = ? AND simulated = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(customerId, simulated ? 1 : 0, limit)
    .all<Row>();
  return results.map((r) => {
    const shown = Number(r.delta_available) !== 0 ? Number(r.delta_available) : Number(r.delta_reserved);
    const type = String(r.type);
    const reason = type.startsWith("adjustment") ? `\n   Reason: ${String(r.description)}` : "";
    return `${ledgerRef(Number(r.id))} · ${LEDGER_LABEL[type] ?? type} · ${shown >= 0 ? "+" : "−"}${formatEtb(Math.abs(shown))}\n   ${dateTimeText(Number(r.created_at))}${reason}`;
  });
}

// ---------- screens ----------

const MAIN_MENU: Button = { text: "🏠 Main Menu", data: CB.main };
const BACK_TO_WALLET: Button = { text: "⬅ My Wallet", data: CB.wallet };
const CANCEL: Button = { text: "✖ Cancel", data: "w:cn" };

const unavailableScreen: Screen = { text: "💰 My Wallet\n\nThe wallet isn't available yet.", buttons: [[MAIN_MENU]] };

async function walletScreen(db: Db, userId: number): Promise<Screen> {
  const b = await getBalances(db, userId, true);
  return {
    text: `💰 My Wallet\n${SIM_BANNER}\n\nAvailable: ${formatEtb(b.available)}\nReserved: ${formatEtb(b.reserved)}\nTotal: ${formatEtb(b.total)}`,
    buttons: [
      [{ text: "➕ Add Money", data: "w:add" }],
      [{ text: "🛍 Pay with Wallet", data: "w:pay" }],
      [{ text: "💸 Withdraw", data: "w:out" }],
      [{ text: "📜 Transaction History", data: "w:hist" }],
      [MAIN_MENU],
    ],
  };
}

// ---------- buttons ----------

export async function handleWalletCallback(db: Db, user: User, data: string, now: number): Promise<FlowResult | null> {
  if (!/^(m:wallet|w:(add|pay|out|hist|cn|m:(cbe|cbb)))$/.test(data)) return null;

  const mode = await getWalletMode(db);
  if (mode !== "test") {
    await clearState(db, user.id);
    return { screen: unavailableScreen };
  }

  if (data === CB.wallet) return { screen: await walletScreen(db, user.id) };
  if (data === "w:pay") return { toast: "Paying with the wallet is coming in the next step.", alert: true };
  if (data === "w:out") return { toast: "Withdrawals are coming in a later step.", alert: true };

  if (data === "w:hist") {
    const lines = await ledgerLines(db, user.id, true, 15);
    return {
      screen: {
        text: `📜 Transaction History\n${SIM_BANNER}\n\n${lines.length === 0 ? "No transactions yet." : lines.join("\n\n")}`,
        buttons: [[BACK_TO_WALLET]],
      },
    };
  }

  if (data === "w:cn") {
    await clearState(db, user.id);
    await db.prepare("UPDATE wallet_deposits SET status = 'cancelled' WHERE customer_id = ? AND status = 'awaiting_receipt'").bind(user.id).run();
    return { screen: await walletScreen(db, user.id), toast: "Cancelled." };
  }

  if (data === "w:add") {
    const open = await db
      .prepare("SELECT id FROM wallet_deposits WHERE customer_id = ? AND status = 'under_verification'")
      .bind(user.id)
      .first();
    if (open) return { toast: "You already have a deposit being checked. Please wait for it.", alert: true };
    await setState(db, user.id, { step: "wd_amount" }, now);
    return {
      screen: {
        text: `➕ Add Money\n${SIM_BANNER}\n\nHow much would you like to add (in ETB)? Type a number, for example 500.`,
        buttons: [[CANCEL]],
      },
    };
  }

  // w:m:cbe / w:m:cbb: the method was chosen. The amount comes from the saved step, never from the button.
  const state = await getState(db, user.id, now);
  if (state?.step !== "wd_method") return { toast: "That step has expired. Please start again.", alert: true };
  const method = data === "w:m:cbe" ? "cbe" : "cbe_birr";
  try {
    await db.batch([
      db.prepare("UPDATE wallet_deposits SET status = 'cancelled' WHERE customer_id = ? AND status = 'awaiting_receipt'").bind(user.id),
      db
        .prepare(
          "INSERT INTO wallet_deposits (customer_id, simulated, amount_santim, method, status, created_at, expires_at) VALUES (?, 1, ?, ?, 'awaiting_receipt', ?, ?)",
        )
        .bind(user.id, state.amount, method, now, now + DEPOSIT_SECONDS),
    ]);
  } catch {
    return { toast: "You already have a deposit being checked. Please wait for it.", alert: true };
  }
  const row = await db
    .prepare("SELECT id FROM wallet_deposits WHERE customer_id = ? AND status = 'awaiting_receipt'")
    .bind(user.id)
    .first<Row>();
  if (!row) return { toast: "Something went wrong. Please try again.", alert: true };
  await setState(db, user.id, { step: "wd_photo", depositId: Number(row.id) }, now);
  return {
    screen: {
      text:
        `➕ Deposit ${depositRef(Number(row.id))} · ${formatEtb(state.amount)}\n${SIM_BANNER}\n\n` +
        "⚠️ TEST MODE: do NOT send any real money. Send any picture here as a stand-in for the receipt.",
      buttons: [[CANCEL]],
    },
  };
}

// ---------- typed text (the amount) ----------

export async function handleWalletText(db: Db, user: User, text: string, now: number): Promise<FlowResult | null> {
  const state = await getState(db, user.id, now);
  if (!state || (state.step !== "wd_amount" && state.step !== "wd_method" && state.step !== "wd_photo")) return null;

  if ((await getWalletMode(db)) !== "test") {
    await clearState(db, user.id);
    return { screen: unavailableScreen };
  }
  if (state.step === "wd_method") {
    return { screen: { text: "Please tap CBE or CBE Birr above, or tap Cancel.", buttons: [] } };
  }
  if (state.step === "wd_photo") {
    return { screen: { text: "Please send a picture (as a photo) for the receipt, or tap Cancel.", buttons: [[CANCEL]] } };
  }

  const amount = parseAmount(text);
  if (amount === null || amount <= 0 || amount > MAX_DEPOSIT_SANTIM) {
    return { screen: { text: "That isn't a valid amount. Type a number like 500 or 99.50, or tap Cancel.", buttons: [[CANCEL]] } };
  }
  await setState(db, user.id, { step: "wd_method", amount }, now);
  return {
    screen: {
      text: `➕ Add ${formatEtb(amount)}\n${SIM_BANNER}\n\nWhich method would you pretend to use?`,
      buttons: [[{ text: "🏦 CBE", data: "w:m:cbe" }], [{ text: "📲 CBE Birr", data: "w:m:cbb" }], [CANCEL]],
    },
  };
}

// ---------- the receipt picture ----------

// Returns null when the customer isn't sending a deposit receipt (so other photo handlers can have it).
export async function handleWalletPhoto(
  db: Db,
  user: User,
  photo: { fileId: string; uniqueId: string },
  now: number,
): Promise<FlowResult | null> {
  const state = await getState(db, user.id, now);
  if (!state || state.step !== "wd_photo") return null;

  if ((await getWalletMode(db)) !== "test") {
    await clearState(db, user.id);
    return { screen: unavailableScreen };
  }
  const d = await db
    .prepare("SELECT id, customer_id, amount_santim, method, status, expires_at FROM wallet_deposits WHERE id = ?")
    .bind(state.depositId)
    .first<Row>();
  if (!d || Number(d.customer_id) !== user.id || String(d.status) !== "awaiting_receipt" || Number(d.expires_at) <= now) {
    await clearState(db, user.id);
    return { screen: { text: "This deposit request has closed. You can start a new one from My Wallet.", buttons: [[BACK_TO_WALLET]] } };
  }
  const reused = await db.prepare("SELECT id FROM wallet_deposits WHERE screenshot_unique_id = ?").bind(photo.uniqueId).first();
  if (reused) {
    return { screen: { text: "That picture was already used for another deposit. Please send a different one.", buttons: [[CANCEL]] } };
  }

  try {
    const res = await db
      .prepare(
        "UPDATE wallet_deposits SET status = 'under_verification', screenshot_file_id = ?, screenshot_unique_id = ?, submitted_at = ? " +
          "WHERE id = ? AND customer_id = ? AND status = 'awaiting_receipt' AND expires_at > ?",
      )
      .bind(photo.fileId, photo.uniqueId, now, state.depositId, user.id, now)
      .run();
    if (res.meta?.changes !== 1) throw new Error("not updated");
  } catch {
    return { toast: "Something went wrong. Please try again.", alert: true };
  }
  await clearState(db, user.id);

  const amount = Number(d.amount_santim);
  const customer = await getCustomer(db, user.id);
  return {
    screen: {
      text: `⏳ Deposit ${depositRef(state.depositId)} received\n${SIM_BANNER}\n\nAmount: ${formatEtb(amount)}\nIt is credited only after it has been checked.`,
      buttons: [[BACK_TO_WALLET]],
    },
    notify: {
      fileId: photo.fileId,
      caption: [
        "🧪 SIMULATED deposit to verify",
        `Deposit ${depositRef(state.depositId)} · ${String(d.method) === "cbe" ? "CBE" : "CBE Birr"}`,
        `Customer: ${customer?.name ?? `Customer ${user.id}`}`,
        `Amount: ${formatEtb(amount)}`,
        "",
        "Test money only. Verify it in Wallet Management.",
      ].join("\n"),
    },
  };
}
