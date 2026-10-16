/**
 * Deskwisp's plans, as Deskwisp Cloud holds each user to them. Every plan has one computer (a sandbox
 * on E2B); what grows with the plan is how many of its screens each bot has, how many hours a month
 * the computer may run (it sleeps when nobody uses it, so only the time it works counts), how many
 * people the user can let watch or use it (People), and the AI credit each month brings.
 *
 * AI credit pays for what the bots do with AI (OpenAI, quick checks, texts), at what it costs Deskwisp
 * (cloud/pricing.ts). Free's comes once, at the first use; Pro's and Max's each month they're paid
 * for, with nothing carried over. The computer's hours are what make a plan cost Deskwisp more than
 * its credit, so they're capped too.
 *
 * The tiers' names are the app's (cloud/protocol.ts DESKWISP_TIERS, kept in step with this); billing
 * (Polar) sets a user's tier, and until then everyone is on Free.
 */
export const PLANS = {
  free_deskwisp: { name: "Free", priceCents: 0, creditMicros: 1_000_000, monthly: false, hours: 10, computers: 1, screens: 1, people: 0 },
  pro_deskwisp: { name: "Pro", priceCents: 2_900, creditMicros: 10_000_000, monthly: true, hours: 60, computers: 1, screens: 2, people: 2 },
  max_deskwisp: { name: "Max", priceCents: 19_900, creditMicros: 100_000_000, monthly: true, hours: 300, computers: 1, screens: 4, people: 5 },
} as const;

/** The plan with more room than this one, if any. */
export const upgradeOf = (t: Tier): Tier | null => (t === "free_deskwisp" ? "pro_deskwisp" : t === "pro_deskwisp" ? "max_deskwisp" : null);

export type Tier = keyof typeof PLANS;

export const isTier = (s: unknown): s is Tier => typeof s === "string" && s in PLANS;

/** The month a computer's hours are counted in ("2026-10", UTC), and when the next one starts (Unix ms). */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
export const nextMonthStart = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
