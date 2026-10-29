import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { handleAdmin, handleAdminText } from "./admin";
import { clearState, getState as getAdminState } from "./admin-state";
import { handleCustomerOrders } from "./orders";
import { handlePaymentCallback, handlePaymentPhoto, handlePaymentText } from "./payment";
import { handleCheckoutCallback, handleCheckoutText, handleContact, startCheckout, type FlowResult } from "./checkout";
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
    for (const button of row) {
      if (button.url) keyboard.url(button.text, button.url);
      else keyboard.text(button.text, button.data);
    }
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

type Reply = { screen?: Screen; toast?: string; alert?: boolean; notify?: { chatId: number; text: string }[] };

// Answers the button tap (toast or alert) and shows the new screen by editing the message.
async function respond(
  ctx: {
    answerCallbackQuery: (o?: { text?: string; show_alert?: boolean }) => Promise<unknown>;
    editMessageText: (text: string, other?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
    api: { sendMessage: (chatId: number, text: string) => Promise<unknown> };
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
  // Tell the customer (for example: payment confirmed, order on its way). A failure here is only logged.
  for (const n of r.notify ?? []) {
    try {
      await ctx.api.sendMessage(n.chatId, n.text);
    } catch (err) {
      console.error("zippy customer notice error:", safeError(err));
    }
  }
}

type Sender = {
  reply: (text: string, other?: { reply_markup?: InlineKeyboard | Keyboard | { remove_keyboard: true } }) => Promise<unknown>;
};

// Sends a checkout step as a new message. When a phone number is needed, Telegram's share button is attached.
async function sendFlow(ctx: Sender, r: FlowResult): Promise<void> {
  if (r.thanks) await ctx.reply(r.thanks, { reply_markup: { remove_keyboard: true } });
  if (!r.screen) return;
  if (r.askContact) {
    await ctx.reply(r.screen.text, { reply_markup: new Keyboard().requestContact("📱 Share my phone number").oneTime().resized() });
  } else {
    await ctx.reply(r.screen.text, r.screen.buttons.length > 0 ? { reply_markup: toKeyboard(r.screen) } : undefined);
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

    // Checkout steps (name, phone, location, review), then cafeteria, menu and cart buttons.
    const user = { id: ctx.from.id, firstName: ctx.from.first_name };
    try {
      const flow = (await handlePaymentCallback(deps.db, user, data, now)) ?? (await handleCheckoutCallback(deps.db, user, data, now));
      if (flow) {
        if (flow.askContact) {
          await ctx.answerCallbackQuery(flow.toast ? { text: flow.toast, show_alert: flow.alert === true } : undefined);
          await sendFlow(ctx, flow);
        } else {
          await respond(ctx, flow);
        }
        return;
      }
      const shop = await handleShop(deps.db, ctx.from.id, data, now);
      if (shop?.next === "checkout") {
        const started = await startCheckout(deps.db, user, now);
        if (started.askContact) {
          await ctx.answerCallbackQuery();
          await sendFlow(ctx, started);
        } else {
          await respond(ctx, started);
        }
        return;
      }
      if (shop) {
        await respond(ctx, shop);
        return;
      }
      const orders = await handleCustomerOrders(deps.db, ctx.from.id, data);
      if (orders) {
        await respond(ctx, orders);
        return;
      }
    } catch (err) {
      console.error("zippy shop error:", safeError(err));
      await ctx.answerCallbackQuery({ text: "Something went wrong. Please try again." });
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const adminBusy =
      userId !== undefined && isAdmin(userId, deps.adminIds) && (await getAdminState(deps.db, userId, nowSeconds)) !== null;
    if (userId !== undefined && !adminBusy) {
      try {
        const who = { id: userId, firstName: ctx.from?.first_name };
        const payFlow = await handlePaymentText(deps.db, who, ctx.message.text, nowSeconds);
        if (payFlow) {
          await sendFlow(ctx, payFlow);
          return;
        }
        const flow = await handleCheckoutText(deps.db, who, ctx.message.text, nowSeconds);
        if (flow) {
          await sendFlow(ctx, flow);
          return;
        }
      } catch (err) {
        console.error("zippy checkout text error:", safeError(err));
        await ctx.reply("Something went wrong. Please try again.");
        return;
      }
    }
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

  // The customer sent a screenshot of their payment receipt.
  bot.on("message:photo", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const sizes = ctx.message.photo;
    const best = sizes[sizes.length - 1];
    try {
      const flow = await handlePaymentPhoto(
        deps.db,
        { id: userId, firstName: ctx.from?.first_name },
        { fileId: best.file_id, uniqueId: best.file_unique_id },
        Math.floor(Date.now() / 1000),
      );
      if (flow.screen) await sendFlow(ctx, flow);
      else if (flow.toast) await ctx.reply(flow.toast);
      if (flow.notify) {
        // Forward the screenshot to every admin. A failure here must not undo the customer's submission.
        for (const adminId of deps.adminIds) {
          try {
            await ctx.api.sendPhoto(adminId, flow.notify.fileId, { caption: flow.notify.caption });
          } catch (err) {
            console.error("zippy notify error:", safeError(err));
          }
        }
      }
    } catch (err) {
      console.error("zippy photo error:", safeError(err));
      await ctx.reply("Something went wrong. Please try again.");
    }
  });

  // The customer tapped "Share my phone number".
  bot.on("message:contact", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    try {
      const flow = await handleContact(
        deps.db,
        { id: userId, firstName: ctx.from?.first_name },
        { phone_number: ctx.message.contact.phone_number, user_id: ctx.message.contact.user_id },
        Math.floor(Date.now() / 1000),
      );
      await sendFlow(ctx, flow);
    } catch (err) {
      console.error("zippy contact error:", safeError(err));
      await ctx.reply("Something went wrong. Please try again.");
    }
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("Tap /start to open the ZIPPY menu.");
  });

  return bot;
}
