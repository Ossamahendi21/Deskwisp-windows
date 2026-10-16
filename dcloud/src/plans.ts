/**
 * Deskwisp's plans, as Deskwisp Cloud holds each user to them. Every plan has one computer (a sandbox
 * on E2B); what grows with the plan is how many of its screens the bots can use at once, and how
 * many people the user can let watch or use it (People).
 *
 * The tiers' names are the app's (cloud/protocol.ts DESKWISP_TIERS); billing (Polar, step 2.4) sets a
 * user's tier, and until then everyone is on Free.
 */
export const PLANS = {
  free_deskwisp: { name: "Free", computers: 1, screens: 1, people: 0 },
  pro_deskwisp: { name: "Pro", computers: 1, screens: 2, people: 2 },
  max_deskwisp: { name: "Max", computers: 1, screens: 4, people: 5 },
} as const;

/** The plan with more room than this one, if any. */
export const upgradeOf = (t: Tier): Tier | null => (t === "free_deskwisp" ? "pro_deskwisp" : t === "pro_deskwisp" ? "max_deskwisp" : null);

export type Tier = keyof typeof PLANS;

export const isTier = (s: unknown): s is Tier => typeof s === "string" && s in PLANS;
