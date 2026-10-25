import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";

/**
 * The little of Polar's API that adding AI credit needs (https://polar.sh/docs): a checkout for one
 * amount, read back to see whether it was paid, and its webhooks checked. Polar is the merchant of
 * record: it takes the payment, the card never comes here.
 */
export type PolarSettings = NonNullable<Config["polar"]>;

export type Checkout = {
  id: string;
  url?: string;
  /** open, expired, confirmed (paying), succeeded or failed. */
  status: string;
  metadata: Record<string, unknown>;
  externalCustomerId: string | null;
  /** Polar's own id for the customer, once the checkout has one. */
  customerId: string | null;
  /** The subscription a plan's checkout made, once paid. */
  subscriptionId: string | null;
  productId: string | null;
  /** The product renews (a subscription): never right for credit bought once. */
  recurring: boolean;
  /** What was paid for it, in cents: after discounts, before taxes (Polar's net_amount). Null until Polar knows. */
  netCents: number | null;
  currency: string | null;
};

/** Polar's refusal, with its HTTP status (404: no such thing in this Polar). */
export class PolarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(p: PolarSettings, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${p.api}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${p.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Polar's own words, without anything of the request (the token never appears in an answer).
    let said = "";
    try {
      const j = JSON.parse(text) as { detail?: unknown; error?: unknown; error_description?: unknown; required_scopes?: unknown; scope?: unknown };
      // A validation error's details say what (where, and why), past its generic name.
      const details = Array.isArray(j.detail)
        ? (j.detail as { loc?: unknown; msg?: unknown }[]).map((d) => `${Array.isArray(d.loc) ? d.loc.join(".") : ""}: ${String(d.msg ?? "")}`).join("; ").slice(0, 300)
        : "";
      said = typeof j.detail === "string" ? j.detail : [typeof j.error === "string" ? j.error : "", details].filter(Boolean).join(": ");
      // A token without a scope this needs: which, when Polar says (the token itself never appears in an answer).
      if (said === "insufficient_scope") {
        const need = Array.isArray(j.required_scopes) ? j.required_scopes.join(", ") : typeof j.scope === "string" ? j.scope : "";
        said += need ? ` (the token needs ${need})` : " (make the token again with checkouts:read and checkouts:write)";
      }
    } catch {}
    throw new PolarError(res.status, `Polar answered ${res.status}${said ? `: ${said}` : ""}`);
  }
  return JSON.parse(text) as T;
}

const checkoutFrom = (j: Record<string, unknown>): Checkout => ({
  id: String(j.id),
  url: typeof j.url === "string" ? j.url : undefined,
  status: typeof j.status === "string" ? j.status : "",
  metadata: j.metadata && typeof j.metadata === "object" ? (j.metadata as Record<string, unknown>) : {},
  externalCustomerId: typeof j.external_customer_id === "string" ? j.external_customer_id : null,
  customerId: typeof j.customer_id === "string" ? j.customer_id : null,
  subscriptionId: typeof j.subscription_id === "string" ? j.subscription_id : null,
  productId: typeof j.product_id === "string" ? j.product_id : null,
  recurring: !!(j.product && typeof j.product === "object" && (j.product as { is_recurring?: unknown }).is_recurring === true),
  netCents: Number.isSafeInteger(j.net_amount) ? (j.net_amount as number) : null,
  currency: typeof j.currency === "string" ? j.currency.toLowerCase() : null,
});

/** The "AI credit" product renews: credit is bought once, so no checkout is opened on it. */
export class RecurringProduct extends Error {
  constructor() {
    super("POLAR_CREDIT_PRODUCT_ID is a subscription product: AI credit needs a one-time product (Products → New product → One-time purchase)");
  }
}

/**
 * A checkout for `cents` of AI credit, for one user: the "AI credit" product at that amount (a price
 * for this checkout only, and the amount a pay-what-you-want price starts at), no discount codes, the
 * user named as Polar's customer by their id, and what it's for in its metadata, which comes back with
 * it. The credit added is what was paid in the end (confirmCredit), whatever was asked.
 */
export async function creditCheckout(p: PolarSettings, o: { product: string; userId: string; email: string | null; cents: number; successUrl: string }): Promise<Checkout> {
  const body = {
    products: [o.product],
    prices: { [o.product]: [{ amount_type: "fixed", price_amount: o.cents, price_currency: "usd" }] },
    amount: o.cents,
    allow_discount_codes: false,
    external_customer_id: o.userId,
    ...(o.email ? { customer_email: o.email } : {}),
    metadata: { deskwisp_kind: "credit", deskwisp_user: o.userId, amount_cents: o.cents },
    success_url: o.successUrl,
  };
  const c = checkoutFrom(
    await call<Record<string, unknown>>(p, "POST", "/checkouts/", body).catch((e: Error) => {
      // A Polar that doesn't take an amount with this product's price: the same without it.
      if (!/^Polar answered 422/.test(e.message)) throw e;
      console.warn(`[billing] Polar turned the checkout's amount down (${e.message}); opening it without`);
      const { amount: _amount, ...rest } = body;
      void _amount;
      return call<Record<string, unknown>>(p, "POST", "/checkouts/", rest);
    }),
  );
  if (c.recurring) throw new RecurringProduct();
  return c;
}

/**
 * A checkout for a paid plan (Pro or Max): its monthly product, the user named as Polar's customer by
 * their id, and the plan in its metadata. Polar makes the subscription once it's paid.
 */
export async function planCheckout(p: PolarSettings, o: { product: string; tier: string; userId: string; email: string | null; successUrl: string }): Promise<Checkout> {
  return checkoutFrom(
    await call<Record<string, unknown>>(p, "POST", "/checkouts/", {
      products: [o.product],
      external_customer_id: o.userId,
      ...(o.email ? { customer_email: o.email } : {}),
      metadata: { deskwisp_kind: "plan", deskwisp_user: o.userId, tier: o.tier },
      success_url: o.successUrl,
    }),
  );
}

/** A subscription as Polar has it. Times in ms. */
export type PolarSubscription = {
  id: string;
  /** incomplete, incomplete_expired, trialing, active, past_due, canceled, unpaid. */
  status: string;
  productId: string | null;
  /** The user: Polar's customer by our id, else the metadata its checkout carried. */
  userId: string | null;
  customerId: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
};

const msOf = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

export async function readSubscription(p: PolarSettings, id: string): Promise<PolarSubscription> {
  return subscriptionFrom(await call<Record<string, unknown>>(p, "GET", `/subscriptions/${encodeURIComponent(id)}`));
}

/**
 * A user's subscriptions (Polar's customer by our id), newest first: for a checkout Polar says is paid
 * before it names the subscription it made. Only theirs, whatever Polar's filter did.
 */
export async function subscriptionsOf(p: PolarSettings, who: { userId: string | null; customerId: string | null }): Promise<PolarSubscription[]> {
  const by = who.customerId ? `customer_id=${encodeURIComponent(who.customerId)}` : `external_customer_id=${encodeURIComponent(who.userId ?? "")}`;
  const j = await call<{ items?: unknown }>(p, "GET", `/subscriptions/?${by}&limit=20&sorting=-started_at`);
  return (Array.isArray(j.items) ? (j.items as Record<string, unknown>[]) : [])
    .map(subscriptionFrom)
    .filter((s) => (who.customerId && s.customerId === who.customerId) || (who.userId && s.userId === who.userId));
}

/** The subscriptions a checkout's orders name (Polar makes the order, and its subscription, from the checkout). */
export async function subscriptionsOfCheckout(p: PolarSettings, checkoutId: string): Promise<string[]> {
  const j = await call<{ items?: unknown }>(p, "GET", `/orders/?checkout_id=${encodeURIComponent(checkoutId)}&limit=10`);
  return (Array.isArray(j.items) ? (j.items as { checkout_id?: unknown; subscription_id?: unknown }[]) : [])
    .filter((o) => o.checkout_id === checkoutId && typeof o.subscription_id === "string")
    .map((o) => o.subscription_id as string);
}

function subscriptionFrom(j: Record<string, unknown>): PolarSubscription {
  const customer = j.customer && typeof j.customer === "object" ? (j.customer as { external_id?: unknown }) : {};
  const metadata = j.metadata && typeof j.metadata === "object" ? (j.metadata as { deskwisp_user?: unknown }) : {};
  return {
    id: String(j.id),
    status: typeof j.status === "string" ? j.status : "",
    productId: typeof j.product_id === "string" ? j.product_id : null,
    userId: typeof customer.external_id === "string" ? customer.external_id : typeof metadata.deskwisp_user === "string" ? metadata.deskwisp_user : null,
    customerId: typeof j.customer_id === "string" ? j.customer_id : null,
    periodStart: msOf(j.current_period_start),
    periodEnd: msOf(j.current_period_end),
    cancelAtPeriodEnd: j.cancel_at_period_end === true,
  };
}

/** A page of Polar's customer portal for the user (by our id): their plan, card, invoices, cancelling. */
export async function portalLink(p: PolarSettings, who: { userId: string; customerId: string | null }, returnUrl?: string): Promise<string> {
  // Polar's own customer id when known: a customer made before Deskwisp named it by our id has none of ours.
  const whom = who.customerId ? { customer_id: who.customerId } : { external_customer_id: who.userId };
  const j = await call<{ customer_portal_url?: unknown }>(p, "POST", "/customer-sessions/", { ...whom, ...(returnUrl ? { return_url: returnUrl } : {}) });
  if (typeof j.customer_portal_url !== "string") throw new Error("Polar didn't give a portal page");
  return j.customer_portal_url;
}

/**
 * Move a subscription to another product (Pro to Max), charging the difference for the rest of the
 * period now (proration "invoice"). Polar answers 402 when the card couldn't pay it.
 */
export async function changeSubscription(p: PolarSettings, id: string, product: string): Promise<PolarSubscription> {
  return subscriptionFrom(await call<Record<string, unknown>>(p, "PATCH", `/subscriptions/${encodeURIComponent(id)}`, { product_id: product, proration_behavior: "invoice" }));
}

/** A checkout as Polar has it now. */
export async function readCheckout(p: PolarSettings, id: string): Promise<Checkout> {
  return checkoutFrom(await call<Record<string, unknown>>(p, "GET", `/checkouts/${encodeURIComponent(id)}`));
}

/** How old a webhook may be (its timestamp), against replays. */
const WEBHOOK_TOLERANCE_S = 5 * 60;

/**
 * Whether a webhook is Polar's (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature
 * "v1,<base64 HMAC-SHA256 of id.timestamp.body>", keyed with the secret's own bytes, as Polar's SDK does).
 */
export function webhookIsPolars(secret: string, headers: Record<string, string | string[] | undefined>, raw: Buffer, now = Date.now()): boolean {
  const one = (h: string) => {
    const v = headers[h];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = one("webhook-id");
  const ts = one("webhook-timestamp");
  const sigs = one("webhook-signature");
  if (!id || !ts || !sigs || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_S) return false;
  const want = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.`).update(raw).digest();
  return sigs.split(" ").some((s) => {
    const [version, b64] = s.split(",");
    if (version !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
