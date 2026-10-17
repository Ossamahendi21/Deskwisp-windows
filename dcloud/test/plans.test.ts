/**
 * Pro and Max through Polar (billing.ts syncSubscription, polar.ts), with a stand-in Polar: the
 * checkout, the plan following the subscription (paid, renewed, upgraded, cancelled, ended), each
 * period's credit once, the portal, and what's turned away. On the JSON store, or on Postgres with
 * DESKWISP_TEST_DATABASE_URL. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { Box, BoxState, Provider } from "../src/providers/types.ts";
import { startServer } from "../src/server.ts";
import { hashKey } from "../src/store.ts";

class Stand implements Provider {
  readonly name = "stand";
  readonly states = new Map<string, BoxState>();
  private box(id: string): Box {
    return { id, exec: async () => ({ output: "[]", exitCode: 0 }), portUrl: (p) => `http://127.0.0.1:${p}` };
  }
  async create() {
    return this.box("box-1");
  }
  async open(id: string) {
    return this.box(id);
  }
  async state() {
    return "running" as BoxState;
  }
  async pause() {}
  async kill() {}
  async keepAwake() {}
}

const TOKEN = "polar_oat_plans_test";
const PRO = "prod_pro";
const MAX = "prod_max";
const SECRET = "polar-plans-webhook-secret";
const DAY = 86_400_000;

type Co = { id: string; status: string; metadata: Record<string, unknown>; product_id: string; external_customer_id: string; subscription_id: string | null };
type Sub = { id: string; status: string; product_id: string; external_id: string; start: number; end: number; cancel: boolean };
const checkouts = new Map<string, Co>();
const subs = new Map<string, Sub>();
const portals: string[] = [];
let n = 0;
const iso = (t: number) => new Date(t).toISOString();
const polar = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (d: Buffer) => chunks.push(d));
  req.on("end", () => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "bad token" });
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    if (req.method === "POST" && req.url === "/v1/checkouts/") {
      const id = `co_${++n}`;
      const co: Co = { id, status: "open", metadata: body.metadata as Record<string, unknown>, product_id: (body.products as string[])[0], external_customer_id: body.external_customer_id as string, subscription_id: null };
      checkouts.set(id, co);
      return send(201, { ...co, url: `https://sandbox.polar.sh/checkout/${id}` });
    }
    if (req.method === "POST" && req.url === "/v1/customer-sessions/") {
      portals.push(body.external_customer_id as string);
      return send(201, { token: "t", customer_portal_url: `https://sandbox.polar.sh/portal/${body.external_customer_id}`, expires_at: iso(Date.now() + DAY) });
    }
    let m = /^\/v1\/checkouts\/([^/]+)$/.exec(req.url ?? "");
    if (req.method === "GET" && m && checkouts.has(m[1])) return send(200, checkouts.get(m[1]));
    m = /^\/v1\/subscriptions\/([^/]+)$/.exec(req.url ?? "");
    const s = m && subs.get(m[1]);
    if (req.method === "GET" && s)
      return send(200, {
        id: s.id,
        status: s.status,
        product_id: s.product_id,
        customer: { external_id: s.external_id },
        metadata: {},
        current_period_start: iso(s.start),
        current_period_end: iso(s.end),
        cancel_at_period_end: s.cancel,
      });
    send(404, { detail: "not found" });
  });
});

const dir = mkdtempSync(join(tmpdir(), "dcloud-plans-"));
const cfg = loadConfig({
  DESKWISP_PROVIDER: "local",
  DESKWISP_DATA_DIR: dir,
  DESKWISP_PORT: "8781",
  DESKWISP_PUBLIC_URL: "http://127.0.0.1:8781",
  POLAR_ACCESS_TOKEN: TOKEN,
  POLAR_PRO_PRODUCT_ID: PRO,
  POLAR_MAX_PRODUCT_ID: MAX,
  POLAR_WEBHOOK_SECRET: SECRET,
  POLAR_API_URL: "http://127.0.0.1:8782",
  ...(process.env.DESKWISP_TEST_DATABASE_URL ? { DATABASE_URL: process.env.DESKWISP_TEST_DATABASE_URL } : {}),
});
let app: Awaited<ReturnType<typeof startServer>>;
let ana = "";
const KEY = `ana-plans-key-${Date.now()}`;
const base = `http://127.0.0.1:${cfg.port}`;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const plan = async () => (await call("GET", "/deskwisp/plan")).json;
const webhook = async (event: unknown) => {
  const body = JSON.stringify(event);
  const id = `msg_${Date.now()}_${Math.random()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
  return (await fetch(`${base}/billing/polar/webhook`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body })).status;
};

before(async () => {
  await new Promise<void>((r) => polar.listen(8782, "127.0.0.1", r));
  app = await startServer(cfg, { provider: new Stand(), verifier: null });
  await new Promise((r) => app.server.once("listening", r));
  ana = (await app.store.upsertUser({ clerkId: `user_ana_plans_${Date.now()}`, email: "ana@example.com", name: "Ana" })).id;
  await app.store.revokeKeys(ana);
  await app.store.addKey(ana, hashKey(KEY), "test");
});
after(async () => {
  app.server.close();
  polar.close();
  rmSync(dir, { recursive: true, force: true });
});

test("upgrading to Pro: Polar's checkout, then the plan and its month of credit once it's paid", async () => {
  assert.equal((await plan()).tier, "free_deskwisp");
  assert.equal((await call("POST", "/deskwisp/portal")).json.code, "no_deskwisp_plan", "nothing to manage on Free");
  assert.equal((await call("POST", "/deskwisp/checkout", { tier: "gold" })).status, 400);

  const r = await call("POST", "/deskwisp/checkout", { tier: "pro_deskwisp" });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/sandbox\.polar\.sh\/checkout\//);
  const co = [...checkouts.values()].at(-1)!;
  assert.equal(co.product_id, PRO);
  assert.equal(co.external_customer_id, ana);
  assert.deepEqual(co.metadata, { deskwisp_kind: "plan", deskwisp_user: ana, tier: "pro_deskwisp" });

  // Back before it's paid: nothing changes.
  assert.match(await (await fetch(`${base}/billing/plan/done?checkout_id=${co.id}`)).text(), /going through/);
  assert.equal((await plan()).tier, "free_deskwisp");

  // Paid: Polar made the subscription.
  const start = Date.now();
  subs.set("sub_1", { id: "sub_1", status: "active", product_id: PRO, external_id: ana, start, end: start + 30 * DAY, cancel: false });
  co.status = "succeeded";
  co.subscription_id = "sub_1";
  assert.match(await (await fetch(`${base}/billing/plan/done?checkout_id=${co.id}`)).text(), /You're on Deskwisp Pro/);
  const p = await plan();
  assert.equal(p.tier, "pro_deskwisp");
  assert.equal(p.status, "active");
  assert.equal(p.credit.plan_left_micros, 10_000_000);
  assert.equal(Date.parse(p.period_end), start + 30 * DAY);
  // The webhook for the same payment adds nothing more.
  assert.equal(await webhook({ type: "order.paid", data: { id: "ord_1", subscription_id: "sub_1", checkout_id: co.id } }), 202);
  assert.equal(await webhook({ type: "subscription.active", data: { id: "sub_1" } }), 202);
  assert.equal((await plan()).credit.plan_left_micros, 10_000_000);
});

test("someone on Pro: Upgrade and Manage plan open Polar's portal", async () => {
  assert.equal((await call("POST", "/deskwisp/checkout", { tier: "pro_deskwisp" })).json.code, "same_plan");
  const before = checkouts.size;
  const up = await call("POST", "/deskwisp/checkout", { tier: "max_deskwisp" });
  assert.equal(up.json.url, `https://sandbox.polar.sh/portal/${ana}`);
  assert.equal(checkouts.size, before, "no second subscription");
  assert.equal((await call("POST", "/deskwisp/portal")).json.url, `https://sandbox.polar.sh/portal/${ana}`);
});

test("changed to Max in the portal: Max, and the rest of Max's month of credit", async () => {
  subs.get("sub_1")!.product_id = MAX;
  assert.equal(await webhook({ type: "subscription.updated", data: { id: "sub_1" } }), 202);
  const p = await plan();
  assert.equal(p.tier, "max_deskwisp");
  assert.equal(p.credit.plan_left_micros, 100_000_000, "$10 had, $90 more: Max's $100 this period");
});

test("a new month paid brings its credit; a cancel shows, then the plan ends on Free", async () => {
  const s = subs.get("sub_1")!;
  s.start = s.end;
  s.end = s.start + 30 * DAY;
  await webhook({ type: "order.paid", data: { id: "ord_2", subscription_id: "sub_1" } });
  let p = await plan();
  assert.equal(p.credit.plan_left_micros, 100_000_000);
  assert.equal(Date.parse(p.period_end), s.end);
  assert.ok(p.credit.left_micros >= 100_000_000);

  s.cancel = true;
  await webhook({ type: "subscription.canceled", data: { id: "sub_1" } });
  p = await plan();
  assert.equal(p.tier, "max_deskwisp", "it runs to the end of the period it's paid for");
  assert.equal(p.cancel_at_period_end, true);

  s.status = "past_due";
  s.cancel = false;
  await webhook({ type: "subscription.updated", data: { id: "sub_1" } });
  assert.equal((await plan()).status, "past_due", "a card that failed: the app says so");

  s.status = "canceled";
  await webhook({ type: "subscription.revoked", data: { id: "sub_1" } });
  assert.equal((await plan()).tier, "free_deskwisp");
});

test("a renewal with no webhook (a PC): the app's look at the plan reads Polar again once the period's over", async () => {
  // Back on Pro, a period that has just ended, and Polar renewed it.
  const start = Date.now() - 31 * DAY;
  subs.set("sub_2", { id: "sub_2", status: "active", product_id: PRO, external_id: ana, start, end: start + 30 * DAY, cancel: false });
  await app.billing.syncSubscription("sub_2");
  const s = subs.get("sub_2")!;
  s.start = s.end;
  s.end = s.start + 30 * DAY;
  // Last read over a minute ago, as a PC with no webhook would have it.
  const kept = (await app.store.subscription(ana))!;
  await app.store.setSubscription({ ...kept, syncedAt: Date.now() - 2 * 60_000 });
  const p = await plan();
  assert.equal(p.tier, "pro_deskwisp");
  assert.equal(Date.parse(p.period_end), s.end);
  assert.equal(p.credit.plan_left_micros, 10_000_000);
});

test("what isn't Pro's or Max's, or isn't this user's, moves no plan", async () => {
  subs.set("sub_x", { id: "sub_x", status: "active", product_id: "prod_other", external_id: ana, start: Date.now(), end: Date.now() + DAY, cancel: false });
  assert.equal(await app.billing.syncSubscription("sub_x"), null);
  subs.set("sub_y", { id: "sub_y", status: "active", product_id: MAX, external_id: "someone-else", start: Date.now(), end: Date.now() + DAY, cancel: false });
  assert.equal(await app.billing.syncSubscription("sub_y"), null);
  // An old subscription ending doesn't take a newer one's plan away.
  subs.get("sub_1")!.status = "canceled";
  await webhook({ type: "subscription.canceled", data: { id: "sub_1" } });
  assert.equal((await plan()).tier, "pro_deskwisp");
});

test("without Pro's and Max's products, upgrades open soon", () => {
  const off = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, POLAR_ACCESS_TOKEN: "t", POLAR_CREDIT_PRODUCT_ID: "c" });
  assert.equal(off.polar?.plans, undefined);
  assert.equal(off.polar?.creditProduct, "c");
});
