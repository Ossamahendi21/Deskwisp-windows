import { join } from "node:path";

/** Deskwisp Cloud's settings, from its environment (dcloud/.env.example lists them). */
export type Config = {
  port: number;
  host: string;
  dataDir: string;
  /** Where people reach this server (the sign-in page's address): DESKWISP_PUBLIC_URL, else http://localhost:<port>. */
  publicUrl: string;
  /** Keys for development, besides signing in: "key=owner" pairs (DESKWISP_API_KEYS). */
  apiKeys: Map<string, string>;
  /** Postgres (Neon) for users, keys and computers; without it, a JSON file in dataDir. */
  databaseUrl?: string;
  /** Clerk: the secret key checks sign-ins here, the publishable key runs Clerk's sign-in on the page. */
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
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
  const port = Number(env.DESKWISP_PORT) || 8791;
  return {
    port,
    host: env.DESKWISP_HOST || "127.0.0.1",
    publicUrl: (env.DESKWISP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    databaseUrl: env.DATABASE_URL || undefined,
    clerkSecretKey: env.CLERK_SECRET_KEY || undefined,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || undefined,
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
