/**
 * Plans, AI credit and computer hours (billing.ts, computers.ts), with a stand-in provider whose boxes
 * answer every command (no real computer): on the JSON store, or on Postgres with
 * DESKWISP_TEST_DATABASE_URL (db/005_ai_credit.sql's functions then do the money math).
 * Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { monthOf } from "../src/plans.ts";
import type { Box, BoxState, Provider } from "../src/providers/types.ts";
import { startServer } from "../src/server.ts";
import { hashKey } from "../src/store.ts";

/** Boxes that do whatever they're asked, and remember whether they're paused. */
class Stand implements Provider {
  readonly name = "stand";
  readonly states = new Map<string, BoxState>();
  private n = 0;
  private box(id: string): Box {
    return { id, exec: async () => ({ output: "[]", exitCode: 0 }), portUrl: (p) => `http://127.0.0.1:${p}` };
  }
  async create() {
    const id = `box-${++this.n}`;
    this.states.set(id, "running");
    return this.box(id);
  }
  async open(id: string) {
    this.states.set(id, "running");
    return this.box(id);
  }
  async state(id: string) {
    return this.states.get(id) ?? "gone";
  }
  async pause(id: string) {
    this.states.set(id, "paused");
  }
  async kill(id: string) {
    this.states.delete(id);
  }
  async keepAwake() {}
}

const dir = mkdtempSync(join(tmpdir(), "dcloud-billing-"));
const SECRET = "test-plan-secret-0123456789abcdef";
const heard: { body: string; ok: boolean }[] = [];
const services = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (d: Buffer) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const ts = String(req.headers["x-deskwisp-timestamp"]);
    const want = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
    heard.push({ body, ok: req.url === "/v1/internal/plan-changed" && req.headers["x-deskwisp-signature"] === want });
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
});
const cfg = loadConfig({
  DESKWISP_PROVIDER: "local",
  DESKWISP_DATA_DIR: dir,
  DESKWISP_PORT: "8796",
  DESKWISP_SERVICES_URL: "http://127.0.0.1:8797",
  DESKWISP_CLOUD_PLAN_SECRET: SECRET,
  ...(process.env.DESKWISP_TEST_DATABASE_URL ? { DATABASE_URL: process.env.DESKWISP_TEST_DATABASE_URL } : {}),
});
const provider = new Stand();
let app: Awaited<ReturnType<typeof startServer>>;
let ana = "";
const KEY = `ana-key-${Date.now()}`;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

before(async () => {
  await new Promise<void>((r) => services.listen(8797, "127.0.0.1", r));
  app = await startServer(cfg, { provider, verifier: null });
  await new Promise((r) => app.server.once("listening", r));
  ana = (await app.store.upsertUser({ clerkId: `user_ana_${Date.now()}`, email: "ana@example.com", name: "Ana" })).id;
  await app.store.revokeKeys(ana);
  // A key of this run's own (a database from an earlier run may hold "ana-key" for another Ana).
  await app.store.addKey(ana, hashKey(KEY), "test");
});
after(async () => {
  app.server.close();
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a new user is on Free, with this month's credit and its hours", async () => {
  const p = await call("GET", "/deskwisp/plan");
  assert.equal(p.status, 200);
  assert.equal(p.json.tier, "free_deskwisp");
  assert.equal(p.json.price_cents, 0);
  assert.equal(p.json.credit.left_micros, 1_000_000);
  assert.equal(p.json.credit.plan_left_micros, 1_000_000, "Free's credit comes each month, like a plan's");
  assert.equal(p.json.credit.free_left_micros, 0);
  // It resets on the 1st (UTC).
  assert.equal(new Date(p.json.credit.plan_resets_at).getUTCDate(), 1);
  assert.equal(p.json.computer_time.limit_seconds, 10 * 3600);
  assert.equal(p.json.computer_time.used_seconds, 0);
  assert.ok(Date.parse(p.json.computer_time.resets_at) > Date.now());
  // Asked again, this month's credit isn't given twice.
  assert.equal((await call("GET", "/deskwisp/plan")).json.credit.left_micros, 1_000_000);
});

test("a paid plan brings its month of credit, and the services server hears of it", async () => {
  const r = await app.billing.changePlan(ana, "pro_deskwisp");
  assert.equal(r.granted, 10_000_000);
  const p = (await call("GET", "/deskwisp/plan")).json;
  assert.equal(p.tier, "pro_deskwisp");
  assert.equal(p.price_cents, 2_900);
  assert.equal(p.status, "active");
  assert.equal(p.credit.plan_left_micros, 10_000_000);
  assert.equal(p.credit.left_micros, 10_000_000, "the plan's month replaces Free's");
  assert.equal(p.computer_time.limit_seconds, 60 * 3600);
  assert.ok(p.period_end);
  const told = heard.at(-1)!;
  assert.ok(told.ok, "signed as cloud/plans.ts checks it");
  assert.deepEqual({ ...JSON.parse(told.body), at: undefined }, { userId: ana, tier: "pro_deskwisp", at: undefined });
  // Upgrading in the same period adds only what the period hasn't had (Max's $100 less Pro's $10).
  const period = { invoice: `inv_up_${Date.now()}`, start: Date.now(), end: Date.parse(p.period_end) };
  assert.equal((await app.billing.changePlan(ana, "max_deskwisp", period)).granted, 90_000_000);
  assert.equal((await app.billing.changePlan(ana, "max_deskwisp", period)).granted, null, "an invoice is granted once");
  assert.equal((await call("GET", "/deskwisp/plan")).json.credit.plan_left_micros, 100_000_000);
  await app.billing.changePlan(ana, "free_deskwisp");
});

test("paying isn't open yet: the app says upgrades open soon", async () => {
  const r = await call("POST", "/deskwisp/checkout", { tier: "pro_deskwisp" });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "deskwisp_plans_off");
  assert.equal((await call("POST", "/deskwisp/computer/active", {})).status, 200);
});

test("a computer's hours are counted, and once they're used it won't wake", async () => {
  const w = await call("POST", "/workspaces", { name: "deskwisp" });
  const c = await call("POST", "/computers", { workspace_id: w.json.id, name: "Wispy" });
  assert.equal(c.status, 200);
  assert.equal((await call("POST", `/computers/${c.json.id}/bash`, { command: "true" })).status, 200);
  // Its time awake counts when it's counted (each minute, and when it sleeps).
  await new Promise((r) => setTimeout(r, 1100));
  await app.computers.sweep();
  assert.ok((await app.store.computerSeconds(ana, monthOf())) >= 1);
  assert.ok((await call("GET", "/deskwisp/plan")).json.computer_time.used_seconds >= 1);

  // The month's 10 hours used: an awake one goes to sleep at the next sweep, and won't wake.
  await app.store.addComputerSeconds(ana, monthOf(), 10 * 3600);
  await app.computers.sweep();
  assert.equal(provider.states.get("box-1"), "paused");
  const woken = await call("POST", `/computers/${c.json.id}/bash`, { command: "true" });
  assert.equal(woken.status, 402);
  assert.equal(woken.json.code, "deskwisp_free_hours");
  assert.match(woken.json.error, /used its 10 hours this month\. It's back \w+ \d+, or upgrade to Pro/);
  // Looking at it still answers (asleep).
  assert.equal((await call("GET", `/computers/${c.json.id}`)).json.status, "suspended");
  // A bigger plan has hours left: it wakes.
  await app.billing.changePlan(ana, "pro_deskwisp");
  assert.equal((await call("POST", `/computers/${c.json.id}/bash`, { command: "true" })).status, 200);
});
