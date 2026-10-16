import { createHmac } from "node:crypto";
import type { Computers } from "./computers.ts";
import { HttpError } from "./computers.ts";
import type { Config } from "./config.ts";
import { PLANS, type Tier } from "./plans.ts";
import type { Store } from "./store.ts";

/**
 * Each user's plan, AI credit and computer time, in the shape the app reads them (horafirm-web's Deskwisp
 * routes, lib/server/plan.ts readDeskwispPlan):
 *
 * - GET /api/deskwisp/plan: the tier and its price, the AI credit left (db/005_ai_credit.sql, which
 *   gives Free's one-time credit the first time it's asked), and the computer's hours this month.
 * - POST /api/deskwisp/computer/active: the app says the computer is in use. Its hours are counted
 *   from the computer itself here (computers.ts), so this only answers.
 * - POST /api/deskwisp/checkout and /portal: paying, once billing (Polar) is in; until then the
 *   app is told upgrades open soon (code deskwisp_plans_off).
 *
 * A plan change (changePlan: billing, or `scripts/set-plan.ts` by hand) grants the paid period's
 * credit and tells the services server (cloud/), which sets up what the plan brings.
 */
export class Billing {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly computers: Computers;
  private readonly planOf: (owner: string) => Promise<Tier>;

  constructor(cfg: Config, store: Store, computers: Computers, planOf: (owner: string) => Promise<Tier>) {
    this.cfg = cfg;
    this.store = store;
    this.computers = computers;
    this.planOf = planOf;
  }

  /** Answers a request under /api/deskwisp. False when the path isn't one of these. */
  async handle(owner: string, method: string, parts: string[]): Promise<unknown | false> {
    if (parts[0] !== "deskwisp") return false;
    const what = parts.slice(1).join("/");
    if (what === "plan" && method === "GET") return this.plan(owner);
    if (what === "computer/active" && method === "POST") return { ok: true };
    if ((what === "checkout" || what === "portal") && method === "POST") throw new HttpError(503, "Upgrades open soon.", "deskwisp_plans_off");
    return false;
  }

  async plan(owner: string) {
    const tier = await this.planOf(owner);
    const p = PLANS[tier];
    const user = await this.store.user(owner).catch(() => null);
    // A development key's owner has no account, so no credit to show.
    const credit = user ? await this.store.credit(user.id).catch((e: Error) => (console.warn(`[billing] ${owner}'s credit: ${e.message}`), null)) : null;
    const time = await this.computers.computerTime(owner);
    return {
      tier,
      name: p.name,
      price_cents: p.priceCents,
      status: tier === "free_deskwisp" ? null : "active",
      period_end: credit?.planEndsAt ? new Date(credit.planEndsAt).toISOString() : null,
      cancel_at_period_end: false,
      ...(credit
        ? {
            credit: {
              left_micros: credit.leftMicros,
              plan_left_micros: credit.planLeftMicros,
              plan_resets_at: credit.planEndsAt ? new Date(credit.planEndsAt).toISOString() : null,
              free_left_micros: credit.freeLeftMicros,
            },
            grants: credit.grants.map((g) => ({ kind: g.kind, tier: g.tier, amount_micros: g.amountMicros, at: new Date(g.at).toISOString() })),
          }
        : {}),
      computer_time: { used_seconds: time.usedSeconds, limit_seconds: time.limitSeconds, resets_at: new Date(time.resetsAt).toISOString() },
    };
  }

  /**
   * Put a user on a plan. A paid one gets its period's AI credit (once per invoice: billing's, or for a
   * change made by hand one per user and period), and the services server hears of it either way.
   * `period`: the paid period (billing's); a month from now when not given.
   */
  async changePlan(userId: string, tier: Tier, period?: { invoice: string; start: number; end: number }) {
    await this.store.setPlan(userId, tier);
    let granted: number | null = null;
    if (tier !== "free_deskwisp") {
      // Whole seconds: the ledger tells periods apart by their end.
      const start = Math.floor((period?.start ?? Date.now()) / 1000) * 1000;
      const end = Math.floor((period?.end ?? start + 30 * 86_400_000) / 1000) * 1000;
      granted = await this.store.grantPlan(userId, tier, period?.invoice ?? `manual:${userId}:${start}`, PLANS[tier].creditMicros, start, end);
    }
    await this.tellServices(userId, tier).catch((e: Error) => console.warn(`[billing] telling the services server about ${userId}: ${e.message}`));
    return { tier, granted };
  }

  /** POST /v1/internal/plan-changed on the services server, signed as cloud/plans.ts checks it. */
  private async tellServices(userId: string, tier: Tier) {
    if (!this.cfg.servicesUrl || !this.cfg.planSecret) return;
    const body = JSON.stringify({ userId, tier, at: new Date().toISOString() });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${createHmac("sha256", this.cfg.planSecret).update(`${ts}.${body}`).digest("hex")}`;
    const res = await fetch(`${this.cfg.servicesUrl}/v1/internal/plan-changed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-deskwisp-timestamp": ts, "x-deskwisp-signature": sig },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`it answered ${res.status}`);
  }
}
