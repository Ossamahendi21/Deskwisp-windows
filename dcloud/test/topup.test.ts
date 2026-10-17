/**
 * AI credit added once (billing.ts, polar.ts, db/007_credit_topup.sql), with a stand-in Polar: the
 * checkout the app opens, the credit added when the buyer comes back and when Polar's webhook says it
 * was paid (once between them), and what's turned away. On the JSON store, or on Postgres with
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
import { webhookIsPolars } from "../src/polar.ts";
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
    this.states.set("box-1", "running");
    return this.box("box-1");
  }
  async open(id: string) {
    return this.box(id);
  }
  async state(id: string) {
    return this.states.get(id) ?? "gone";
  }
  async pause() {}
  async kill() {}
  async keepAwake() {}
}

// The stand-in Polar: checkouts as it was asked for them, and their status as the test sets it.
const TOKEN = "polar_oat_test_token";
const PRODUCT = "prod_ai_credit";
const WEBHOOK_SECRET = "polar-webhook-secret-for-tests";
type Co = { id: string; status: string; metadata: Record<string, unknown>; external_customer_id: string | null; body: Record<string, unknown> };
const checkouts = new Map<string, Co>();
let n = 0;
const polar = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (d: Buffer) => chunks.push(d));
  req.on("end", () => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "bad token" });
    if (req.method === "POST" && req.url === "/v1/checkouts/") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const id = `co_${++n}_${Date.now()}`;
      const co: Co = { id, status: "open", metadata: body.metadata as Record<string, unknown>, external_customer_id: (body.external_customer_id as string) ?? null, body };
      checkouts.set(id, co);
      return send(201, { id, url: `https://sandbox.polar.sh/checkout/${id}`, status: co.status, metadata: co.metadata, external_customer_id: co.external_customer_id });
    }
    const m = /^\/v1\/checkouts\/([^/]+)$/.exec(req.url ?? "");
    const co = m && checkouts.get(decodeURIComponent(m[1]));
    if (req.method === "GET" && co) return send(200, { id: co.id, status: co.status, metadata: co.metadata, external_customer_id: co.external_customer_id });
    send(404, { detail: "not found" });
  });
});

const dir = mkdtempSync(join(tmpdir(), "dcloud-topup-"));
const cfg = loadConfig({
  DESKWISP_PROVIDER: "local",
  DESKWISP_DATA_DIR: dir,
  DESKWISP_PORT: "8793",
  DESKWISP_PUBLIC_URL: "http://127.0.0.1:8793",
  POLAR_ACCESS_TOKEN: TOKEN,
  POLAR_CREDIT_PRODUCT_ID: PRODUCT,
  POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
  POLAR_API_URL: "http://127.0.0.1:8794",
  ...(process.env.DESKWISP_TEST_DATABASE_URL ? { DATABASE_URL: process.env.DESKWISP_TEST_DATABASE_URL } : {}),
});
let app: Awaited<ReturnType<typeof startServer>>;
let ana = "";
const KEY = `ana-topup-key-${Date.now()}`;
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
const left = async () => (await call("GET", "/deskwisp/plan")).json.credit as { left_micros: number; free_left_micros: number; plan_left_micros: number };

/** A webhook as Polar signs it (Standard Webhooks). */
const webhook = async (event: unknown, secret = WEBHOOK_SECRET) => {
  const body = JSON.stringify(event);
  const id = `msg_${Date.now()}_${Math.random()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
  const res = await fetch(`${base}/billing/polar/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
    body,
  });
  return res.status;
};

before(async () => {
  await new Promise<void>((r) => polar.listen(8794, "127.0.0.1", r));
  app = await startServer(cfg, { provider: new Stand(), verifier: null });
  await new Promise((r) => app.server.once("listening", r));
  ana = (await app.store.upsertUser({ clerkId: `user_ana_topup_${Date.now()}`, email: "ana@example.com", name: "Ana" })).id;
  await app.store.revokeKeys(ana);
  await app.store.addKey(ana, hashKey(KEY), "test");
});
after(async () => {
  app.server.close();
  polar.close();
  rmSync(dir, { recursive: true, force: true });
});

test("adding credit is on, always through Checkout: no card is kept here", async () => {
  assert.deepEqual((await call("GET", "/deskwisp/credit/card-on-file")).json, { card: null, pending: [] });
  const onCard = await call("POST", "/deskwisp/credit/card-on-file", { amount_cents: 2000, card_handle: "x".repeat(20) });
  assert.equal(onCard.status, 402);
  assert.equal(onCard.json.status, "checkout", "the app opens Checkout instead; nothing charged");
});

test("only $5 to $1,000, in whole dollars", async () => {
  for (const amount_cents of [499, 100_100, 2050, "2000", null]) {
    const r = await call("POST", "/deskwisp/credit/checkout", { amount_cents });
    assert.equal(r.status, 400, String(amount_cents));
    assert.equal(r.json.code, "invalid_amount");
  }
});

test("a checkout is paid: the credit is added once, and it doesn't expire", async () => {
  const before = await left();
  const r = await call("POST", "/deskwisp/credit/checkout", { amount_cents: 50_00 });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\//);
  const co = [...checkouts.values()].at(-1)!;
  // What Polar was asked: the credit product at this checkout's own price, for Ana, back to dcloud.
  assert.deepEqual(co.body.products, [PRODUCT]);
  assert.deepEqual(co.body.prices, { [PRODUCT]: [{ amount_type: "fixed", price_amount: 5000, price_currency: "usd" }] });
  assert.equal(co.body.external_customer_id, ana);
  assert.deepEqual(co.metadata, { deskwisp_kind: "credit", deskwisp_user: ana, amount_cents: 5000 });
  assert.equal(co.body.success_url, `${base}/billing/credit/done?checkout_id={CHECKOUT_ID}`);

  // Back from the page before the payment's through: nothing yet.
  const early = await fetch(`${base}/billing/credit/done?checkout_id=${co.id}`);
  assert.match(await early.text(), /going through/);
  assert.equal((await left()).left_micros, before.left_micros);

  // Paid: the page coming back adds it...
  co.status = "succeeded";
  const done = await fetch(`${base}/billing/credit/done?checkout_id=${co.id}`);
  assert.match(await done.text(), /\$50 of AI credit added/);
  const after = await left();
  assert.equal(after.left_micros, before.left_micros + 50_000_000);
  assert.equal(after.free_left_micros, before.free_left_micros + 50_000_000, "to the credit that doesn't expire");
  // ...and Polar's webhook for the same payment, or the page again, adds nothing more.
  assert.equal(await webhook({ type: "order.paid", data: { id: "ord_1", checkout_id: co.id } }), 202);
  await fetch(`${base}/billing/credit/done?checkout_id=${co.id}`);
  assert.equal((await left()).left_micros, after.left_micros);
  const plan = (await call("GET", "/deskwisp/plan")).json;
  assert.ok(plan.grants.some((g: { kind: string; amount_micros: number }) => g.kind === "topup" && g.amount_micros === 50_000_000), "the app shows it as added credit");
});

test("Polar's webhook alone adds a paid checkout's credit", async () => {
  const before = (await left()).left_micros;
  await call("POST", "/deskwisp/credit/checkout", { amount_cents: 1000_00 });
  const co = [...checkouts.values()].at(-1)!;
  co.status = "succeeded";
  assert.equal(await webhook({ type: "order.paid", data: { id: "ord_2", checkout_id: co.id } }), 202);
  assert.equal((await left()).left_micros, before + 1_000_000_000);
});

test("what isn't Polar's, isn't paid, or isn't credit adds nothing", async () => {
  const before = (await left()).left_micros;
  await call("POST", "/deskwisp/credit/checkout", { amount_cents: 20_00 });
  const co = [...checkouts.values()].at(-1)!;
  // A webhook signed with another secret, or not signed at all.
  co.status = "succeeded";
  assert.equal(await webhook({ type: "order.paid", data: { checkout_id: co.id } }, "someone-else"), 403);
  assert.equal((await fetch(`${base}/billing/polar/webhook`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await left()).left_micros, before);
  // A checkout that failed.
  co.status = "failed";
  assert.match(await (await fetch(`${base}/billing/credit/done?checkout_id=${co.id}`)).text(), /didn't go through/);
  // A checkout that's someone else's in Polar (its customer isn't the user its metadata names).
  co.status = "succeeded";
  co.external_customer_id = "someone-else";
  await fetch(`${base}/billing/credit/done?checkout_id=${co.id}`);
  assert.equal((await left()).left_micros, before);
});

test("a webhook's signature: Polar's key, the body as it came, and not an old one", () => {
  const body = Buffer.from('{"type":"order.paid"}');
  const ts = Math.floor(Date.now() / 1000);
  const sig = (t: number, b: Buffer) => `v1,${createHmac("sha256", Buffer.from(WEBHOOK_SECRET)).update(`m1.${t}.`).update(b).digest("base64")}`;
  const h = (t: number, s: string) => ({ "webhook-id": "m1", "webhook-timestamp": String(t), "webhook-signature": s });
  assert.equal(webhookIsPolars(WEBHOOK_SECRET, h(ts, sig(ts, body)), body), true);
  assert.equal(webhookIsPolars(WEBHOOK_SECRET, h(ts, `v1,bad v1,${sig(ts, body).slice(3)}`), body), true, "any of several signatures");
  assert.equal(webhookIsPolars(WEBHOOK_SECRET, h(ts, sig(ts, body)), Buffer.from('{"type":"order.paid "}')), false);
  assert.equal(webhookIsPolars(WEBHOOK_SECRET, h(ts - 3600, sig(ts - 3600, body)), body), false, "too old");
});

test("without Polar set up, adding credit opens soon", async () => {
  const off = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir });
  assert.equal(off.polar, undefined);
  // Polar's live server, without the go-ahead for real payments: off too.
  const live = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, POLAR_ACCESS_TOKEN: "t", POLAR_CREDIT_PRODUCT_ID: "p", POLAR_SERVER: "production" });
  assert.equal(live.polar, undefined);
  const sandbox = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, POLAR_ACCESS_TOKEN: "t", POLAR_CREDIT_PRODUCT_ID: "p" });
  assert.equal(sandbox.polar?.api, "https://sandbox-api.polar.sh");
});
