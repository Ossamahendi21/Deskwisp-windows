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
};

async function call<T>(p: PolarSettings, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
      said = typeof j.detail === "string" ? j.detail : typeof j.error === "string" ? j.error : Array.isArray(j.detail) ? JSON.stringify(j.detail).slice(0, 300) : "";
      // A token without a scope this needs: which, when Polar says (the token itself never appears in an answer).
      if (said === "insufficient_scope") {
        const need = Array.isArray(j.required_scopes) ? j.required_scopes.join(", ") : typeof j.scope === "string" ? j.scope : "";
        said += need ? ` (the token needs ${need})` : " (make the token again with checkouts:read and checkouts:write)";
      }
    } catch {}
    throw new Error(`Polar answered ${res.status}${said ? `: ${said}` : ""}`);
  }
  return JSON.parse(text) as T;
}

const checkoutFrom = (j: Record<string, unknown>): Checkout => ({
  id: String(j.id),
  url: typeof j.url === "string" ? j.url : undefined,
  status: typeof j.status === "string" ? j.status : "",
  metadata: j.metadata && typeof j.metadata === "object" ? (j.metadata as Record<string, unknown>) : {},
  externalCustomerId: typeof j.external_customer_id === "string" ? j.external_customer_id : null,
});

/**
 * A checkout for `cents` of AI credit, for one user: the "AI credit" product at a price for this
 * checkout only (an ad-hoc price), the user named as Polar's customer by their id, and what it's for
 * in its metadata, which comes back with it.
 */
export async function creditCheckout(p: PolarSettings, o: { userId: string; email: string | null; cents: number; successUrl: string }): Promise<Checkout> {
  const j = await call<Record<string, unknown>>(p, "POST", "/checkouts/", {
    products: [p.creditProduct],
    prices: { [p.creditProduct]: [{ amount_type: "fixed", price_amount: o.cents, price_currency: "usd" }] },
    external_customer_id: o.userId,
    ...(o.email ? { customer_email: o.email } : {}),
    metadata: { deskwisp_kind: "credit", deskwisp_user: o.userId, amount_cents: o.cents },
    success_url: o.successUrl,
  });
  return checkoutFrom(j);
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
