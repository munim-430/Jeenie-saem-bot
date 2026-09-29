// GET /api/session: Jeannie's opening line for a new session, a Korean
// greeting for the operator's local time of day plus an encouraging line,
// addressed with a weighted honorific.

import { sessionGreeting } from "@/lib/agents/etiquette";
import { requireAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import type { SessionGreeting } from "@/lib/types";
import { jsonResponse } from "@/lib/utils";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const denied = requireAccess(req);
  if (denied) return denied;
  const body: SessionGreeting = sessionGreeting({ timeZone: getEnv().timeZone });
  return jsonResponse(body);
}
