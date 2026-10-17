import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Computers } from "./computers.ts";
import { HttpError } from "./computers.ts";
import type { Config } from "./config.ts";
import { PLANS, type Tier } from "./plans.ts";
import { creditCheckout, planCheckout, portalLink, readCheckout, readSubscription, RecurringProduct, subscriptionsOf, subscriptionsOfCheckout, webhookIsPolars, type PolarSubscription } from "./polar.ts";
import type { Store, Subscription } from "./store.ts";

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
 * - AI credit added once (top-ups, lib/credit-topup.ts in the app): $5 to $1,000, at face value, paid
 *   through Polar's checkout. GET /api/deskwisp/credit/card-on-file says it's on (no card is kept
 *   here, so it's always Checkout), POST /api/deskwisp/credit/checkout opens one. The credit is added
 *   once Polar says the checkout succeeded: when its page sends the buyer back here
 *   (/billing/credit/done) and when Polar's webhook says so (/billing/polar/webhook), whichever comes
 *   first, once (db/007_credit_topup.sql). Off (code deskwisp_credit_off: "opens soon") without Polar.
 *
 * Pro and Max (POLAR_PRO_PRODUCT_ID, POLAR_MAX_PRODUCT_ID: monthly subscription products):
 * - POST /api/deskwisp/checkout {tier}: Polar's checkout for that plan; for someone who already pays,
 *   Polar's customer portal instead, where they change plans. POST /api/deskwisp/portal: the portal
 *   (card, invoices, cancelling).
 * - The plan follows the subscription as Polar has it (syncSubscription), read from Polar whenever it
 *   says something changed: the checkout sending the buyer back (/billing/plan/done), Polar's webhook
 *   (a new month paid, a change of plan, a cancel), and on the app's look at the plan once a period has
 *   ended or a while has gone by (so it holds with no webhook reaching a PC). Each paid period brings
 *   its month of credit once; an upgrade in a period adds what's left of the higher plan's.
 *
 * A plan change (changePlan: billing, or `scripts/set-plan.ts` by hand) grants the paid period's
 * credit and tells the services server (cloud/), which sets up what the plan brings.
 */
export class Billing {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly computers: Computers;
  private readonly planOf: (owner: string) => Promise<Tier>;
  /**
   * Plan checkouts opened and not yet seen through, by user: the app's look at the plan checks them, so
   * a payment counts even when the buyer never comes back to dcloud's page and no webhook reaches it.
   */
  private readonly pendingPlans = new Map<string, { checkout: string; at: number; checkedAt: number }>();

  constructor(cfg: Config, store: Store, computers: Computers, planOf: (owner: string) => Promise<Tier>) {
    this.cfg = cfg;
    this.store = store;
    this.computers = computers;
    this.planOf = planOf;
  }

  /** Answers a request under /api/deskwisp. False when the path isn't one of these. */
  async handle(owner: string, method: string, parts: string[], body: () => Promise<unknown> = async () => ({})): Promise<unknown | false> {
    if (parts[0] !== "deskwisp") return false;
    const what = parts.slice(1).join("/");
    if (what === "plan" && method === "GET") return this.plan(owner);
    if (what === "credit/card-on-file" && method === "GET") {
      this.creditOn();
      return { card: null, pending: [] };
    }
    if (what === "credit/card-on-file" && method === "POST") {
      this.creditOn();
      // Polar keeps no card to charge from here: it's Checkout, and nothing was charged.
      throw Object.assign(new HttpError(402, "There's no card on file.", "no_card"), { extra: { status: "checkout" } });
    }
    if (what === "credit/checkout" && method === "POST") return this.creditCheckout(owner, ((await body()) as { amount_cents?: unknown }).amount_cents);
    if (what === "computer/active" && method === "POST") return { ok: true };
    if (what === "checkout" && method === "POST") return this.planCheckout(owner, ((await body()) as { tier?: unknown }).tier);
    if (what === "portal" && method === "POST") return this.portal(owner);
    return false;
  }

  /** Paid plans are sold (Polar has Pro's and Max's products), else the app's "Upgrades open soon". */
  private plansOn() {
    const polar = this.cfg.polar;
    if (!polar?.plans) throw new HttpError(503, "Upgrades open soon.", "deskwisp_plans_off");
    return { polar, plans: polar.plans };
  }

  /** Pro or Max: Polar's checkout for it, or for someone who already pays, the portal to change plans. */
  private async planCheckout(owner: string, tier: unknown) {
    const { polar, plans } = this.plansOn();
    if (tier !== "pro_deskwisp" && tier !== "max_deskwisp") throw new HttpError(400, "Pick Pro or Max.", "invalid_tier");
    const user = await this.store.user(owner);
    if (!user) throw new HttpError(403, "Sign in to upgrade.", "no_account");
    const sub = await this.store.subscription(user.id);
    if (sub && paying(sub)) {
      if (sub.tier === tier) throw new HttpError(409, `You're on ${PLANS[tier].name} already.`, "same_plan");
      return { url: await this.portalUrl(user.id) };
    }
    const c = await planCheckout(polar, { product: plans[tier], tier, userId: user.id, email: user.email, successUrl: `${this.cfg.publicUrl}/billing/plan/done?checkout_id={CHECKOUT_ID}` }).catch((e: Error) => {
      console.warn(`[billing] opening ${tier}'s checkout for ${user.id}: ${e.message}`);
      throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    });
    if (!c.url) throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    this.pendingPlans.set(user.id, { checkout: c.id, at: Date.now(), checkedAt: 0 });
    return { url: c.url };
  }

  /**
   * See a plan's checkout through: the plan once it's paid. Polar may say it's paid (sending the buyer
   * back) a moment before it names the subscription it made, so then the user's newest subscription to
   * Pro or Max is the one. "waiting" until Polar has it, "not_paid" when it won't be.
   */
  async confirmPlanCheckout(checkoutId: string): Promise<{ userId: string; tier: Tier; status: string } | "waiting" | "not_paid" | null> {
    const { polar, plans } = this.plansOn();
    const c = await readCheckout(polar, checkoutId);
    if (c.metadata.deskwisp_kind !== "plan") return null;
    if (c.status === "open" || c.status === "confirmed") return "waiting";
    if (c.status !== "succeeded") return "not_paid";
    let subscription = c.subscriptionId;
    // Not on the checkout: its order names it, else the customer's newest subscription to Pro or Max.
    if (!subscription) subscription = (await subscriptionsOfCheckout(polar, c.id).catch((e: Error) => (console.warn(`[billing] the orders of checkout ${c.id}: ${e.message}`), [])))[0] ?? null;
    if (!subscription) {
      const userId = typeof c.metadata.deskwisp_user === "string" ? c.metadata.deskwisp_user : c.externalCustomerId;
      const ours = new Set(Object.values(plans));
      const all = await subscriptionsOf(polar, { userId, customerId: c.customerId });
      const found = all.find((s) => s.productId && ours.has(s.productId) && PAYING.has(s.status));
      if (!found) {
        // What Polar has for this customer, to tell why (no ids but the checkout's, nothing personal).
        const seen = all.map((s) => `${s.status}${s.productId && ours.has(s.productId) ? "" : " (another product)"}`).join(", ") || "none";
        console.log(`[billing] checkout ${c.id} is paid; no subscription to Pro or Max for its customer on Polar yet (has: ${seen}; customer ${c.customerId ? "known" : "not on the checkout"})`);
        return "waiting";
      }
      subscription = found.id;
    }
    return this.syncSubscription(subscription);
  }

  /** Polar's customer portal: the plan, the card, invoices, cancelling. Only for someone who's had a paid plan. */
  private async portal(owner: string) {
    this.plansOn();
    const user = await this.store.user(owner);
    const sub = user ? await this.store.subscription(user.id) : null;
    if (!user || !sub) throw new HttpError(409, "You don't have a paid plan to manage yet.", "no_deskwisp_plan");
    return { url: await this.portalUrl(user.id) };
  }

  private async portalUrl(userId: string) {
    const { polar } = this.plansOn();
    return portalLink(polar, userId).catch((e: Error) => {
      console.warn(`[billing] opening the portal for ${userId}: ${e.message}`);
      throw new HttpError(502, "Couldn't open your plan's page. Try again in a minute.", "portal_unavailable");
    });
  }

  /**
   * Bring a user's plan in line with a Polar subscription: its tier while it's paid for (active,
   * trialing, or past due while Polar tries the card again), with each paid period's credit once; Free
   * when it has ended. Only the user's latest subscription moves their plan. What the user is on now.
   */
  async syncSubscription(subscriptionId: string): Promise<{ userId: string; tier: Tier; status: string } | null> {
    const { polar, plans } = this.plansOn();
    let s: PolarSubscription;
    try {
      s = await readSubscription(polar, subscriptionId);
    } catch (e) {
      throw new Error(`reading subscription ${subscriptionId}: ${(e as Error).message}`);
    }
    const tier = (Object.keys(plans) as ("pro_deskwisp" | "max_deskwisp")[]).find((t) => plans[t] === s.productId);
    if (!tier) {
      console.warn(`[billing] subscription ${s.id} isn't for Pro's or Max's product: left alone`);
      return null;
    }
    const user = s.userId ? await this.userById(s.userId) : null;
    if (!user) {
      console.warn(`[billing] subscription ${s.id} is for a user who isn't here (${s.userId}): left alone`);
      return null;
    }
    const was = await this.store.subscription(user.id);
    // An older subscription's news never moves the plan of someone on a newer one.
    if (was && was.subscriptionId !== s.id && paying(was) && !PAYING.has(s.status)) return { userId: user.id, tier: user.plan, status: was.status };
    const now: Subscription = {
      userId: user.id,
      subscriptionId: s.id,
      tier,
      status: s.status,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      syncedAt: Date.now(),
    };
    await this.store.setSubscription(now);
    if (PAYING.has(s.status)) {
      // Each period, and each plan within one (an upgrade), grants once: changePlan's ledger keeps it to that.
      const fresh = !was || was.subscriptionId !== s.id || was.periodStart !== s.periodStart || was.tier !== tier || user.plan !== tier;
      if (fresh) {
        const start = s.periodStart ?? Date.now();
        const r = await this.changePlan(user.id, tier, { invoice: `polar:sub:${s.id}:${new Date(start).toISOString()}:${tier}`, start, end: s.periodEnd ?? start + 30 * 86_400_000 });
        console.log(`[billing] ${user.id} is on ${PLANS[tier].name}${r.granted ? `, with ${usd(r.granted / 10_000)} of this period's credit` : ""} (subscription ${s.id}, ${s.status})`);
      }
      return { userId: user.id, tier, status: s.status };
    }
    if (ENDED.has(s.status) && user.plan !== "free_deskwisp") {
      await this.changePlan(user.id, "free_deskwisp");
      console.log(`[billing] ${user.id} is back on Free (subscription ${s.id}, ${s.status})`);
      return { userId: user.id, tier: "free_deskwisp", status: s.status };
    }
    return { userId: user.id, tier: user.plan, status: s.status };
  }

  /** A user by the id Polar carried back (ours), or null for one that isn't ours at all. */
  private userById(id: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? this.store.user(id) : Promise.resolve(null);
  }

  /** Adding credit is on (Polar's set up with the credit product), else the app's "opens soon". */
  private creditOn() {
    if (!this.cfg.polar?.creditProduct) throw new HttpError(503, "Adding credit opens soon.", "deskwisp_credit_off");
    return this.cfg.polar;
  }

  /** A Polar checkout for `cents` of AI credit: its page, for the user's browser. */
  private async creditCheckout(owner: string, cents: unknown) {
    const polar = this.creditOn();
    if (!topUpCents(cents)) throw new HttpError(400, "Choose $20, $50, $100, or a whole-dollar amount from $5 to $1,000.", "invalid_amount");
    const user = await this.store.user(owner);
    if (!user) throw new HttpError(403, "Sign in to add credit.", "no_account");
    const c = await creditCheckout(polar, { product: polar.creditProduct!, userId: user.id, email: user.email, cents, successUrl: `${this.cfg.publicUrl}/billing/credit/done?checkout_id={CHECKOUT_ID}` }).catch((e: Error) => {
      console.warn(`[billing] opening a checkout for ${user.id}: ${e.message}`);
      if (e instanceof RecurringProduct) throw new HttpError(503, "Adding credit isn't available right now. Try again later.", "checkout_unavailable");
      throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    });
    if (!c.url) throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    return { url: c.url };
  }

  /**
   * Add a checkout's credit if Polar says it was paid: to the user its metadata names (who must be
   * Polar's customer for it too), what was paid in the end (its net amount: after discounts, before
   * taxes, never the amount asked, which a pay-what-you-want page lets the buyer change), once per
   * checkout, and only for the one-time "AI credit" product. What became of it.
   */
  async confirmCredit(checkoutId: string): Promise<{ state: "added" | "already" | "waiting" | "not_paid" | "not_credit"; cents?: number }> {
    const polar = this.creditOn();
    const c = await readCheckout(polar, checkoutId);
    if (c.metadata.deskwisp_kind !== "credit") return { state: "not_credit" };
    if (c.status === "open" || c.status === "confirmed") return { state: "waiting" };
    if (c.status !== "succeeded") return { state: "not_paid" };
    const userId = c.metadata.deskwisp_user;
    if (typeof userId !== "string" || (c.externalCustomerId && c.externalCustomerId !== userId)) {
      console.warn(`[billing] checkout ${c.id} was paid but doesn't say whose credit it is: not added`);
      return { state: "not_credit" };
    }
    if ((c.productId && c.productId !== polar.creditProduct) || c.recurring || (c.currency && c.currency !== "usd")) {
      console.warn(`[billing] checkout ${c.id} was paid, but not for the one-time AI credit product in dollars: not added`);
      return { state: "not_credit" };
    }
    // Whatever was paid, even past the $1,000 the app offers (a pay-what-you-want page lets the buyer
    // type more): paid for, so it's theirs.
    const cents = c.netCents;
    if (cents === null || cents <= 0) {
      console.warn(`[billing] checkout ${c.id} was paid, but Polar didn't say an amount Deskwisp adds (${cents}): not added`);
      return { state: "not_credit" };
    }
    const user = await this.userById(userId);
    if (!user) {
      console.warn(`[billing] checkout ${c.id} was paid for a user who isn't here (${userId}): not added`);
      return { state: "not_credit" };
    }
    const added = await this.store.grantTopUp(user.id, user.plan, `polar:checkout:${c.id}`, cents * 10_000);
    if (added !== null) console.log(`[billing] ${user.id} added ${usd(cents)} of AI credit (checkout ${c.id})`);
    return { state: added === null ? "already" : "added", cents };
  }

  /**
   * What Polar reaches without a sign-in: the page its checkout sends the buyer back to, and its
   * webhook. False when the path isn't one of these. Before any other route reads the body (the
   * webhook's signature is over it as it came).
   */
  async public(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/billing/polar/webhook" && req.method === "POST") {
      const polar = this.cfg.polar;
      const raw = await rawBody(req);
      if (!polar?.webhookSecret || !webhookIsPolars(polar.webhookSecret, req.headers, raw)) {
        res.writeHead(polar?.webhookSecret ? 403 : 503, { "Content-Type": "application/json" }).end('{"error":"not accepted"}');
        return true;
      }
      let event: { type?: unknown; data?: { id?: unknown; checkout_id?: unknown; status?: unknown } } = {};
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {}
      // Only pointers: what a checkout or subscription is, and whether it's paid, are read from Polar itself.
      const type = String(event.type ?? "");
      const data = (event.data ?? {}) as { id?: unknown; checkout_id?: unknown; status?: unknown; subscription_id?: unknown };
      const checkout = type === "order.paid" ? data.checkout_id : type === "checkout.updated" && data.status === "succeeded" ? data.id : null;
      const subscription = type.startsWith("subscription.") ? data.id : type === "order.paid" ? data.subscription_id : null;
      try {
        // A plan's checkout is its subscription's news; a credit checkout adds its credit.
        if (typeof subscription === "string" && subscription && polar.plans) await this.syncSubscription(subscription);
        else if (typeof checkout === "string" && checkout && polar.creditProduct) await this.confirmCredit(checkout);
      } catch (e) {
        // Polar sends it again when it isn't answered 2xx.
        console.warn(`[billing] Polar's ${type}: ${(e as Error).message}`);
        res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":"try again"}');
        return true;
      }
      res.writeHead(202, { "Content-Type": "application/json" }).end('{"ok":true}');
      return true;
    }
    if (url.pathname === "/billing/plan/done" && req.method === "GET") {
      const id = url.searchParams.get("checkout_id") ?? "";
      let said = "Nothing to see here.";
      let refresh = false;
      if (this.cfg.polar?.plans && /^[A-Za-z0-9_-]{1,100}$/.test(id)) {
        const got = await this.confirmPlanCheckout(id).catch((e: Error) => (console.warn(`[billing] checking plan checkout ${id}: ${e.message}`), "waiting" as const));
        // Still going through: the page looks again in a few seconds, by itself.
        if (got === "waiting") refresh = true;
        said =
          got && typeof got === "object" && got.tier !== "free_deskwisp"
            ? `You're on Deskwisp ${PLANS[got.tier].name}. Its credit is in, and your bots have more room. You can go back to Deskwisp.`
            : got === "not_paid"
              ? "This payment didn't go through, so your plan hasn't changed."
              : "Your payment is going through. Your plan changes in Deskwisp as soon as it's done.";
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(donePage(said, refresh));
      return true;
    }
    if (url.pathname === "/billing/credit/done" && req.method === "GET") {
      const id = url.searchParams.get("checkout_id") ?? "";
      let said: string;
      if (!this.cfg.polar?.creditProduct || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) said = "Nothing to add here.";
      else {
        const got = await this.confirmCredit(id).catch((e: Error) => (console.warn(`[billing] checking checkout ${id}: ${e.message}`), null));
        said =
          got?.state === "added" || got?.state === "already"
            ? `${usd(got.cents ?? 0)} of AI credit added. It doesn't expire. You can go back to Deskwisp.`
            : got?.state === "waiting" || !got
              ? "Your payment is going through. The credit shows in Deskwisp as soon as it's done."
              : "This payment didn't go through, so nothing was added.";
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(donePage(said));
      return true;
    }
    return false;
  }

  async plan(owner: string) {
    const user = await this.store.user(owner).catch(() => null);
    // The subscription read again from Polar when its period is over or it's been a while (a renewal, a
    // cancel or a card that failed, with no webhook to say so: a PC). Never in the way of the answer.
    let sub = user ? await this.store.subscription(user.id).catch(() => null) : null;
    if (sub && this.cfg.polar?.plans && (Date.now() - sub.syncedAt > RESYNC_MS || (sub.periodEnd !== null && sub.periodEnd < Date.now() && Date.now() - sub.syncedAt > 60_000))) {
      await Promise.race([this.syncSubscription(sub.subscriptionId).catch((e: Error) => console.warn(`[billing] ${e.message}`)), new Promise((r) => setTimeout(r, 4000))]);
      sub = await this.store.subscription(sub.userId).catch(() => sub);
    }
    // A plan checkout opened from here and not seen through yet: looked at again (every 15 seconds at most, for a day).
    const pending = user && this.cfg.polar?.plans ? this.pendingPlans.get(user.id) : undefined;
    if (user && pending && Date.now() - pending.at < 86_400_000 && Date.now() - pending.checkedAt > 15_000) {
      pending.checkedAt = Date.now();
      const got = await Promise.race([
        this.confirmPlanCheckout(pending.checkout).catch((e: Error) => (console.warn(`[billing] checking plan checkout ${pending.checkout}: ${e.message}`), "waiting" as const)),
        new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 4000)),
      ]);
      if (got !== "waiting") this.pendingPlans.delete(user.id);
      if (got && typeof got === "object") sub = await this.store.subscription(user.id).catch(() => sub);
    } else if (user && pending && Date.now() - pending.at >= 86_400_000) this.pendingPlans.delete(user.id);
    const tier = await this.planOf(owner);
    const p = PLANS[tier];
    const billed = sub && sub.tier === tier && tier !== "free_deskwisp" ? sub : null;
    // A development key's owner has no account, so no credit to show.
    const credit = user ? await this.store.credit(user.id).catch((e: Error) => (console.warn(`[billing] ${owner}'s credit: ${e.message}`), null)) : null;
    const time = await this.computers.computerTime(owner);
    return {
      tier,
      name: p.name,
      price_cents: p.priceCents,
      status: tier === "free_deskwisp" ? null : billed?.status === "past_due" ? "past_due" : "active",
      period_end: billed?.periodEnd ? new Date(billed.periodEnd).toISOString() : credit?.planEndsAt ? new Date(credit.planEndsAt).toISOString() : null,
      cancel_at_period_end: !!billed?.cancelAtPeriodEnd,
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

/** Polar's subscription statuses while it's paid for (past_due: a card failed, and Polar is trying it again). */
const PAYING = new Set(["active", "trialing", "past_due"]);
/** Polar's subscription statuses once it's over. */
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
const paying = (s: Subscription) => PAYING.has(s.status) && (s.periodEnd === null || s.periodEnd > Date.now() - 3 * 86_400_000);
/** How long the app's look at the plan trusts what was last read from Polar. */
const RESYNC_MS = 30 * 60_000;

/** "$20", "$20.50". */
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** A whole-dollar amount from $5 to $1,000, in cents (the app's isTopUpAmount). */
function topUpCents(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 500 && v <= 100_000 && v % 100 === 0;
}

function rawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 1024 * 1024) {
        reject(new HttpError(413, "body too large", "too_large"));
        req.destroy();
      } else chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const escape = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The page Polar's checkout sends the buyer back to; `refresh`: it looks again in a few seconds. */
function donePage(said: string, refresh = false) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>Deskwisp</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#F7F6F3;color:#1A1A1A}
main{max-width:420px;margin:24px;padding:32px;border-radius:20px;background:#fff;box-shadow:0 0 0 1px #E6E6E3;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4A4A4A}</style>
<main><h1>Deskwisp</h1><p>${escape(said)}</p></main>`;
}
