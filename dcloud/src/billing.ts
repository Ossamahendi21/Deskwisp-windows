import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Computers } from "./computers.ts";
import { HttpError } from "./computers.ts";
import type { Config } from "./config.ts";
import { PLANS, type Tier } from "./plans.ts";
import { creditCheckout, readCheckout, webhookIsPolars } from "./polar.ts";
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
 * - AI credit added once (top-ups, lib/credit-topup.ts in the app): $5 to $1,000, at face value, paid
 *   through Polar's checkout. GET /api/deskwisp/credit/card-on-file says it's on (no card is kept
 *   here, so it's always Checkout), POST /api/deskwisp/credit/checkout opens one. The credit is added
 *   once Polar says the checkout succeeded: when its page sends the buyer back here
 *   (/billing/credit/done) and when Polar's webhook says so (/billing/polar/webhook), whichever comes
 *   first, once (db/007_credit_topup.sql). Off (code deskwisp_credit_off: "opens soon") without Polar.
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
    if ((what === "checkout" || what === "portal") && method === "POST") throw new HttpError(503, "Upgrades open soon.", "deskwisp_plans_off");
    return false;
  }

  /** Adding credit is on (Polar's set up), else the app's "opens soon". */
  private creditOn() {
    if (!this.cfg.polar) throw new HttpError(503, "Adding credit opens soon.", "deskwisp_credit_off");
    return this.cfg.polar;
  }

  /** A Polar checkout for `cents` of AI credit: its page, for the user's browser. */
  private async creditCheckout(owner: string, cents: unknown) {
    const polar = this.creditOn();
    if (!topUpCents(cents)) throw new HttpError(400, "Choose $20, $50, $100, or a whole-dollar amount from $5 to $1,000.", "invalid_amount");
    const user = await this.store.user(owner);
    if (!user) throw new HttpError(403, "Sign in to add credit.", "no_account");
    const c = await creditCheckout(polar, { userId: user.id, email: user.email, cents, successUrl: `${this.cfg.publicUrl}/billing/credit/done?checkout_id={CHECKOUT_ID}` }).catch((e: Error) => {
      console.warn(`[billing] opening a checkout for ${user.id}: ${e.message}`);
      throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    });
    if (!c.url) throw new HttpError(502, "Couldn't open checkout. Try again in a minute.", "checkout_unavailable");
    return { url: c.url };
  }

  /**
   * Add a checkout's credit if Polar says it was paid: to the user its metadata names (who must be
   * Polar's customer for it too), the amount it was opened for, once per checkout. What became of it.
   */
  async confirmCredit(checkoutId: string): Promise<{ state: "added" | "already" | "waiting" | "not_paid" | "not_credit"; cents?: number }> {
    const polar = this.creditOn();
    const c = await readCheckout(polar, checkoutId);
    if (c.metadata.deskwisp_kind !== "credit") return { state: "not_credit" };
    if (c.status === "open" || c.status === "confirmed") return { state: "waiting" };
    if (c.status !== "succeeded") return { state: "not_paid" };
    const userId = c.metadata.deskwisp_user;
    const cents = Number(c.metadata.amount_cents);
    if (typeof userId !== "string" || (c.externalCustomerId && c.externalCustomerId !== userId) || !topUpCents(cents)) {
      console.warn(`[billing] checkout ${c.id} was paid but doesn't say whose credit it is: not added`);
      return { state: "not_credit" };
    }
    const user = await this.store.user(userId);
    if (!user) {
      console.warn(`[billing] checkout ${c.id} was paid for a user who isn't here (${userId}): not added`);
      return { state: "not_credit" };
    }
    const added = await this.store.grantTopUp(user.id, user.plan, `polar:checkout:${c.id}`, cents * 10_000);
    if (added !== null) console.log(`[billing] ${user.id} added $${cents / 100} of AI credit (checkout ${c.id})`);
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
      // Only a pointer to the checkout: what it was for and whether it's paid are read from Polar itself.
      const checkout = event.type === "order.paid" ? event.data?.checkout_id : event.type === "checkout.updated" && event.data?.status === "succeeded" ? event.data?.id : null;
      if (typeof checkout === "string" && checkout) {
        try {
          await this.confirmCredit(checkout);
        } catch (e) {
          // Polar sends it again when it isn't answered 2xx.
          console.warn(`[billing] Polar's ${String(event.type)} for checkout ${checkout}: ${(e as Error).message}`);
          res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":"try again"}');
          return true;
        }
      }
      res.writeHead(202, { "Content-Type": "application/json" }).end('{"ok":true}');
      return true;
    }
    if (url.pathname === "/billing/credit/done" && req.method === "GET") {
      const id = url.searchParams.get("checkout_id") ?? "";
      let said: string;
      if (!this.cfg.polar || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) said = "Nothing to add here.";
      else {
        const got = await this.confirmCredit(id).catch((e: Error) => (console.warn(`[billing] checking checkout ${id}: ${e.message}`), null));
        said =
          got?.state === "added" || got?.state === "already"
            ? `$${((got.cents ?? 0) / 100).toLocaleString("en-US")} of AI credit added. It doesn't expire. You can go back to Deskwisp.`
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

/** The page Polar's checkout sends the buyer back to. */
function donePage(said: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deskwisp</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#F7F6F3;color:#1A1A1A}
main{max-width:420px;margin:24px;padding:32px;border-radius:20px;background:#fff;box-shadow:0 0 0 1px #E6E6E3;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4A4A4A}</style>
<main><h1>Deskwisp</h1><p>${escape(said)}</p></main>`;
}
