import { hangeulHudMode } from "@/lib/agents/hangeul-bridge";
import { configuredSearchProviders, configuredTtsEngines, getEnv } from "@/lib/env";
import type { SystemStatus } from "@/lib/types";
import { jsonResponse } from "@/lib/utils";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Deliberately open (no access key): the HUD calls this first to learn whether
// it must ask for a key. Only booleans and model names leave the server.
export function GET(): Response {
  const env = getEnv();
  const online = env.llm.provider !== "none";
  const status: SystemStatus = {
    app: env.appName,
    voiceName: env.voiceName,
    accessKeyRequired: Boolean(env.accessKey),
    llm: {
      provider: env.llm.provider,
      model: online ? env.llm.model : null,
      visionModel: online ? env.llm.visionModel : null,
    },
    search: { providers: configuredSearchProviders(env) },
    voice: { engines: configuredTtsEngines(env) },
    telegram: { configured: Boolean(env.telegram.botToken) },
    // "live" only when the HUD really gets live data, which needs the access key.
    hangeul: { mode: hangeulHudMode(env) },
    time: new Date().toISOString(),
  };
  return jsonResponse(status);
}
