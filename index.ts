import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { parseAdminIds, safeEqual } from "./auth";
import { createBot } from "./bot";
import { runMigrations, schemaVersion, type Db } from "./db";

export interface Env {
  DB: Db;
  BOT_TOKEN?: string; // secret
  WEBHOOK_SECRET?: string; // secret
  SETUP_KEY?: string; // secret (delete it after setup to switch /setup off)
  ADMIN_IDS?: string; // secret
}

// Kept between requests while this Worker instance stays warm.
let cachedBotInfo: UserFromGetMe | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Never write secrets into logs.
function safeMessage(err: unknown, env: Env): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
  for (const secret of [env.BOT_TOKEN, env.WEBHOOK_SECRET, env.SETUP_KEY]) {
    if (secret) text = text.split(secret).join("***");
  }
  return text.slice(0, 300);
}

const SECRET_TOKEN_FORMAT = /^[A-Za-z0-9_-]{24,256}$/;

async function handleHealth(env: Env): Promise<Response> {
  let db = "error";
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok === 1) db = "ok";
  } catch {
    // leave as "error"
  }
  return json({
    ok: db === "ok",
    app: "zippy-bot",
    db,
    schema: db === "ok" ? await schemaVersion(env.DB) : null,
    configured: {
      botToken: Boolean(env.BOT_TOKEN),
      webhookSecret: Boolean(env.WEBHOOK_SECRET),
      adminCount: parseAdminIds(env.ADMIN_IDS).size,
    },
  });
}

async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_KEY) return json({ error: "Setup is switched off." }, 404);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await safeEqual(key, env.SETUP_KEY))) return json({ error: "Forbidden." }, 403);

  if (!env.BOT_TOKEN) return json({ error: "BOT_TOKEN secret is missing." }, 400);
  if (!env.WEBHOOK_SECRET || !SECRET_TOKEN_FORMAT.test(env.WEBHOOK_SECRET)) {
    return json({ error: "WEBHOOK_SECRET must be 24 to 256 characters: letters, digits, _ or - only." }, 400);
  }
  if (env.SETUP_KEY.length < 24) return json({ error: "SETUP_KEY must be at least 24 characters." }, 400);

  const migrationsApplied = await runMigrations(env.DB);

  const base = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
  const me = (await (await fetch(`${base}/getMe`)).json()) as {
    ok: boolean;
    result?: { username?: string };
    description?: string;
  };
  if (!me.ok) return json({ error: "Telegram rejected the bot token.", detail: me.description ?? null }, 400);

  const webhookUrl = `${new URL(request.url).origin}/telegram`;
  const hook = (await (
    await fetch(`${base}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    })
  ).json()) as { ok: boolean; description?: string };

  return json({
    ok: hook.ok,
    botUsername: me.result?.username ?? null,
    migrationsApplied,
    webhook: hook.ok ? "set" : (hook.description ?? "failed"),
    webhookUrl,
  });
}

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Only Telegram knows the secret. Anything else is rejected before any work happens.
  const sent = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.WEBHOOK_SECRET || !(await safeEqual(sent, env.WEBHOOK_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!env.BOT_TOKEN) return new Response("Bot is not configured", { status: 500 });

  const bot = createBot({
    token: env.BOT_TOKEN,
    db: env.DB,
    adminIds: parseAdminIds(env.ADMIN_IDS),
    botInfo: cachedBotInfo,
  });
  if (!cachedBotInfo) {
    await bot.init();
    cachedBotInfo = bot.botInfo;
  }
  const handle = webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET });
  return await handle(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") return await handleHealth(env);
      if (pathname === "/setup") return await handleSetup(request, env);
      if (pathname === "/telegram") return await handleTelegram(request, env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("zippy error:", safeMessage(err, env));
      // A non-2xx answer makes Telegram retry the update later.
      return new Response("Server error", { status: 500 });
    }
  },
};
