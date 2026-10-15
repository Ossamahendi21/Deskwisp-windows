import { join } from "node:path";

/** Deskwisp Cloud's settings, from its environment (dcloud/.env.example lists them). */
export type Config = {
  port: number;
  host: string;
  dataDir: string;
  /** Who may call the computers API, by key: "key=owner" pairs (until accounts, step 2.2, replace them). */
  apiKeys: Map<string, string>;
  provider: "e2b" | "local";
  e2bApiKey?: string;
  e2bTemplate: string;
  /** How long a computer stays awake after its last use before it pauses. */
  idleMs: number;
  /** How many computers each owner may have, and their size. */
  maxComputers: number;
  cpu: number;
  ramGb: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const keys = new Map<string, string>();
  for (const pair of (env.DESKWISP_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    if (at > 0) keys.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const provider = env.DESKWISP_PROVIDER === "local" ? "local" : "e2b";
  if (provider === "e2b" && !env.E2B_API_KEY) throw new Error("E2B_API_KEY is missing (or set DESKWISP_PROVIDER=local for development)");
  return {
    port: Number(env.DESKWISP_PORT) || 8791,
    host: env.DESKWISP_HOST || "127.0.0.1",
    dataDir: env.DESKWISP_DATA_DIR || join(process.cwd(), ".dcloud-data"),
    apiKeys: keys,
    provider,
    e2bApiKey: env.E2B_API_KEY,
    e2bTemplate: env.E2B_TEMPLATE || "deskwisp-computer",
    idleMs: (Number(env.DESKWISP_IDLE_MINUTES) || 15) * 60_000,
    maxComputers: Number(env.DESKWISP_MAX_COMPUTERS) || 3,
    cpu: Number(env.DESKWISP_COMPUTER_CPU) || 2,
    ramGb: Number(env.DESKWISP_COMPUTER_RAM_GB) || 4,
  };
}
