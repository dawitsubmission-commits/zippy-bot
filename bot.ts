import { Bot, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAdmin } from "./auth";
import { claimUpdate, releaseUpdate, type Db } from "./db";
import { adminPanel, mainMenu, routeCallback, type Screen } from "./screens";

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
function isNotModified(err: unknown): boolean {
  const description = (err as { description?: unknown } | null)?.description;
  return typeof description === "string" && description.includes("message is not modified");
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

  bot.on("callback_query:data", async (ctx) => {
    const result = routeCallback(ctx.callbackQuery.data, isAdmin(ctx.from.id, deps.adminIds));
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

  bot.on("message", async (ctx) => {
    await ctx.reply("Tap /start to open the ZIPPY menu.");
  });

  return bot;
}
