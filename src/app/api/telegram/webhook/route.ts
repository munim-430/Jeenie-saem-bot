import { getEnv } from "@/lib/env";
import { handleTelegramUpdate } from "@/lib/telegram";
import { errorResponse, jsonResponse, timingSafeEqual } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function POST(req: Request): Promise<Response> {
  const { webhookSecret, botToken } = getEnv().telegram;
  if (webhookSecret && !timingSafeEqual(req.headers.get(SECRET_HEADER) ?? "", webhookSecret)) {
    return errorResponse(401, "invalid_webhook_secret", "Invalid Telegram webhook secret.");
  }
  if (!botToken) return errorResponse(503, "telegram_not_configured", "TELEGRAM_BOT_TOKEN is not configured.");

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be JSON.");
  }

  try {
    await handleTelegramUpdate(update);
  } catch (error) {
    // Still 200: a non-2xx makes Telegram redeliver the same update indefinitely.
    console.error(`[telegram] webhook handling failed: ${error instanceof Error ? error.name : "Error"}`);
  }
  return jsonResponse({ ok: true });
}
