import { z } from "zod";
import { formatHangeulReport, getHangeulReport, getHangeulStatus } from "@/lib/agents/hangeul-bridge";
import { isCronRequest, isTrustedRequest, requireAccess } from "@/lib/auth";
import { notifyAdmin } from "@/lib/telegram";
import { errorResponse, jsonResponse } from "@/lib/utils";

// Node.js: the daily cron run also pushes the report to Telegram.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const queryActionSchema = z.enum(["report", "status"]);
const postSchema = z.object({ action: z.enum(["report", "status", "notify"]) });

async function fetchAction(action: "report" | "status", req: Request): Promise<Response> {
  const options = { trusted: isTrustedRequest(req), signal: req.signal };
  if (action === "status") return jsonResponse({ status: await getHangeulStatus(options) });
  return jsonResponse({ report: await getHangeulReport(options) });
}

/** Daily report pushed to the Telegram admin chat. Callers must already be trusted. */
async function deliverDailyReport(req: Request): Promise<Response> {
  const report = await getHangeulReport({ trusted: true, signal: req.signal });
  const delivered = await notifyAdmin(formatHangeulReport(report, "bilingual"));
  return jsonResponse({ report, delivered });
}

export async function GET(req: Request): Promise<Response> {
  const action = new URL(req.url).searchParams.get("action");
  const cron = isCronRequest(req);
  // Vercel Cron calls the bare path with `Authorization: Bearer $CRON_SECRET`.
  if (cron && !action) return deliverDailyReport(req);

  if (!cron) {
    const denied = requireAccess(req);
    if (denied) return denied;
  }
  const parsed = queryActionSchema.safeParse(action ?? "report");
  if (!parsed.success) return errorResponse(400, "invalid_action", "action must be \"report\" or \"status\".");
  return fetchAction(parsed.data, req);
}

export async function POST(req: Request): Promise<Response> {
  if (!isCronRequest(req)) {
    const denied = requireAccess(req);
    if (denied) return denied;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be JSON.");
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "invalid_action", "action must be \"report\", \"status\" or \"notify\".");

  if (parsed.data.action === "notify") {
    if (!isTrustedRequest(req)) {
      return errorResponse(403, "not_trusted", "Sending the report to Telegram needs the access key or cron secret.");
    }
    return deliverDailyReport(req);
  }
  return fetchAction(parsed.data.action, req);
}
