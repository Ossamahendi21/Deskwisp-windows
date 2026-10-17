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
  /** Optional: invite emails sent with Resend (RESEND_API_KEY, from DESKWISP_MAIL_FROM); without it the app shows the link to send. */
  resendApiKey?: string;
  mailFrom?: string;
  /**
   * The app's services server (cloud/, DESKWISP_SERVICES_URL, e.g. http://127.0.0.1:8790): told when a
   * user's plan changes (POST /v1/internal/plan-changed, signed with DESKWISP_CLOUD_PLAN_SECRET, the
   * same secret cloud/ has), so it sets up what the plan brings at once.
   */
  servicesUrl?: string;
  planSecret?: string;
  /**
   * Polar, which sells AI credit added once (billing.ts): an organization access token, the one-time
   * product "AI credit" whose price each checkout sets, and the webhook's secret. Polar's sandbox unless
   * POLAR_SERVER=production, which also needs DESKWISP_LIVE_PAYMENTS=1: no real payments until
   * selling Deskwisp is cleared (COMMERCIAL-PERMISSION.md). Without the token and product, adding credit
   * is off and the app says it opens soon.
   */
  polar?: { token: string; creditProduct?: string; plans?: { pro_deskwisp: string; max_deskwisp: string }; webhookSecret?: string; api: string; live: boolean };
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
    resendApiKey: env.RESEND_API_KEY || undefined,
    mailFrom: env.DESKWISP_MAIL_FROM || undefined,
    servicesUrl: (env.DESKWISP_SERVICES_URL || "").replace(/\/+$/, "") || undefined,
    planSecret: env.DESKWISP_CLOUD_PLAN_SECRET || undefined,
    polar: polarConfig(env),
  };
}

function polarConfig(env: NodeJS.ProcessEnv): Config["polar"] {
  const token = env.POLAR_ACCESS_TOKEN?.trim();
  const creditProduct = env.POLAR_CREDIT_PRODUCT_ID?.trim() || undefined;
  // Pro and Max are sold only when both are set (Products → New product → Recurring subscription, monthly).
  const pro = env.POLAR_PRO_PRODUCT_ID?.trim();
  const max = env.POLAR_MAX_PRODUCT_ID?.trim();
  const plans = pro && max ? { pro_deskwisp: pro, max_deskwisp: max } : undefined;
  if (!token || (!creditProduct && !plans)) return undefined;
  const live = env.POLAR_SERVER === "production";
  if (live && env.DESKWISP_LIVE_PAYMENTS !== "1") {
    console.warn("[dcloud] POLAR_SERVER=production needs DESKWISP_LIVE_PAYMENTS=1 (once selling Deskwisp is cleared): paying stays off");
    return undefined;
  }
  const api = (env.POLAR_API_URL || (live ? "https://api.polar.sh" : "https://sandbox-api.polar.sh")).replace(/\/+$/, "");
  return { token, creditProduct, plans, webhookSecret: env.POLAR_WEBHOOK_SECRET?.trim() || undefined, api, live };
}
