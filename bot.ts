import { Bot, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { clearState, handleAdmin, handleAdminText } from "./admin";
import { isAdmin } from "./auth";
import { claimUpdate, releaseUpdate, runMigrations, type Db } from "./db";
import { adminPanel, mainMenu, routeCallback, type Screen } from "./screens";
import { handleShop, type ShopResult } from "./store";

export type BotDeps = {
  token: string;
  db: Db;
  adminIds: Set<number>;
  botInfo?: UserFromGetMe;
};

function toKeyboard(screen: Screen): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  screen.buttons.forEach((row, index) => {
    for (const button of row) keyboard.text(button.text, button.data);
    if (index < screen.buttons.length - 1) keyboard.row();
  });
  return keyboard;
}

// Telegram complains if we "edit" a message to the exact same content. That is harmless.
function safeError(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : "unknown error").slice(0, 300);
}

function isNotModified(err: unknown): boolean {
  const description = (err as { description?: unknown } | null)?.description;
  return typeof description === "string" && description.includes("message is not modified");
}

type Reply = { screen?: Screen; toast?: string; alert?: boolean };

// Answers the button tap (toast or alert) and shows the new screen by editing the message.
async function respond(
  ctx: {
    answerCallbackQuery: (o?: { text?: string; show_alert?: boolean }) => Promise<unknown>;
    editMessageText: (text: string, other?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
  },
  r: Reply,
): Promise<void> {
  await ctx.answerCallbackQuery(r.toast ? { text: r.toast, show_alert: r.alert === true } : undefined);
  if (r.screen) {
    try {
      await ctx.editMessageText(r.screen.text, { reply_markup: toKeyboard(r.screen) });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);

  // 1) Only talk in private chats. Ignore groups and channels completely.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  // 2) Duplicate protection: each Telegram update is handled once.
  //    If handling fails, we release it so Telegram's retry can try again.
  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const isFirstTime = await claimUpdate(deps.db, updateId, Math.floor(Date.now() / 1000));
    if (!isFirstTime) return;
    try {
      await next();
    } catch (err) {
      await releaseUpdate(deps.db, updateId).catch(() => {});
      throw err;
    }
  });

  bot.command("start", async (ctx) => {
    const menu = mainMenu();
    await ctx.reply(menu.text, { reply_markup: toKeyboard(menu) });
  });

  // Temporary helper so the owner can learn their own numeric Telegram ID.
  // It answers only while no admin is configured yet, or to an existing admin.
  bot.command("myid", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (deps.adminIds.size === 0 || isAdmin(userId, deps.adminIds)) {
      await ctx.reply(`Your Telegram user ID is: ${userId}`);
    }
  });

  // Non-admins get no reply at all.
  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx.from?.id, deps.adminIds)) return;
    const panel = adminPanel();
    await ctx.reply(panel.text, { reply_markup: toKeyboard(panel) });
  });

  // Admin-only: applies any pending database updates that came with a new version of the code.
  bot.command("dbupdate", async (ctx) => {
    if (!isAdmin(ctx.from?.id, deps.adminIds)) return;
    try {
      const applied = await runMigrations(deps.db);
      await ctx.reply(applied.length > 0 ? `Database updated: ${applied.join(", ")}` : "Database is already up to date.");
    } catch (err) {
      console.error("zippy dbupdate error:", safeError(err));
      await ctx.reply("Database update failed. Nothing was changed.");
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const now = Math.floor(Date.now() / 1000);
    const admin = isAdmin(ctx.from.id, deps.adminIds);

    // Admin buttons: the Telegram ID is checked here on the server, whatever buttons were shown.
    if (data.startsWith("a:")) {
      if (!admin) {
        await ctx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }
      let adminResult: Reply | null;
      try {
        adminResult = await handleAdmin(deps.db, ctx.from.id, data, now);
      } catch (err) {
        console.error("zippy admin error:", safeError(err));
        await ctx.answerCallbackQuery({ text: "Something went wrong. Nothing was changed." });
        return;
      }
      if (adminResult) {
        await respond(ctx, adminResult);
        return;
      }
    }

    // Cafeteria, menu and cart buttons (they need the database).
    let shop: ShopResult | null;
    try {
      shop = await handleShop(deps.db, ctx.from.id, data, now);
    } catch (err) {
      console.error("zippy shop error:", safeError(err));
      await ctx.answerCallbackQuery({ text: "Something went wrong. Please try again." });
      return;
    }
    if (shop) {
      await respond(ctx, shop);
      return;
    }

    const result = routeCallback(data, admin);
    if (result.kind === "denied") {
      await ctx.answerCallbackQuery({ text: "Not authorized." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(result.screen.text, { reply_markup: toKeyboard(result.screen) });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  });

  // Admin only: stop whatever you were in the middle of (for example typing a price).
  bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !isAdmin(userId, deps.adminIds)) return;
    await clearState(deps.db, userId);
    await ctx.reply("Cancelled.");
  });

  // Text typed by the admin while an admin tool is waiting for it (a new price, name or fee).
  // Everyone else just gets the hint.
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId !== undefined && isAdmin(userId, deps.adminIds)) {
      try {
        const screen = await handleAdminText(deps.db, userId, ctx.message.text, Math.floor(Date.now() / 1000));
        if (screen) {
          await ctx.reply(screen.text, screen.buttons.length > 0 ? { reply_markup: toKeyboard(screen) } : undefined);
          return;
        }
      } catch (err) {
        console.error("zippy admin text error:", safeError(err));
        await ctx.reply("Something went wrong. Nothing was changed.");
        return;
      }
    }
    await ctx.reply("Tap /start to open the ZIPPY menu.");
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("Tap /start to open the ZIPPY menu.");
  });

  return bot;
}
