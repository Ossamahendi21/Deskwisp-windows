/**
 * Deskwisp's plans, as Deskwisp Cloud holds each user to them. Every plan has one computer (a sandbox
 * on E2B); what grows with the plan is how many of its screens the bots can use at once.
 *
 * The tiers' names are the app's (cloud/protocol.ts DESKWISP_TIERS); billing (Polar, step 2.4) sets a
 * user's tier, and until then everyone is on Free.
 */
export const PLANS = {
  free_deskwisp: { name: "Free", computers: 1, screens: 1 },
  pro_deskwisp: { name: "Pro", computers: 1, screens: 2 },
  max_deskwisp: { name: "Max", computers: 1, screens: 4 },
} as const;

export type Tier = keyof typeof PLANS;

export const isTier = (s: unknown): s is Tier => typeof s === "string" && s in PLANS;
