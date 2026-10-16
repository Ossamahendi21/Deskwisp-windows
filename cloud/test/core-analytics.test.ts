import { POSTHOG_PROJECT } from "../analytics-rules.ts";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { after, before, beforeEach, test } from "node:test";
import { shutdownTelemetry } from "../analytics.ts";
import { closeDb, query } from "../db.ts";
import { call, dropUsers, fakeHorafirm, fakeProvider, keyOf, newUserId, prepareDb, startCloud, type Got, type Listening } from "./core-fakes.ts";

/** No PostHog project of Deskwisp's yet (analytics-rules.ts): nothing is sent, so there's nothing to see. */
const noProject = POSTHOG_PROJECT ? false : "no PostHog project of Deskwisp's yet";

/**
 * Usage events from Deskwisp Cloud (analytics.ts, README "Usage events"): a new user's first session is
 * one deskwisp_signup_completed and later sessions none; a plan change from horafirm-web's notice is one
 * deskwisp_plan_changed with the person's deskwisp_plan, and the same notice again none. Nothing for a call
 * marked x-deskwisp-telemetry: off, for a user whose state has analyticsOff, or with DESKWISP_TELEMETRY unset.
 * PostHog is a fake on localhost (DESKWISP_UPSTREAM_POSTHOG).
 */

const SECRET = randomBytes(32).toString("base64");
const users: string[] = [];
let horafirm: Listening, cloud: Listening;
let posthog: Awaited<ReturnType<typeof fakeProvider>>;

/** What PostHog got: each event of each batch, its body gunzipped. */
const events = () =>
  posthog.got
    .filter((g: Got) => g.path === "/batch/")
    .flatMap((g: Got) => {
      const raw = g.headers["content-encoding"] === "gzip" ? gunzipSync(g.body) : g.body;
      return (JSON.parse(raw.toString("utf8")) as { batch: { event: string; distinct_id: string; uuid?: string; properties: Record<string, unknown> }[] }).batch;
    });
const of = (userId: string, event: string) => events().filter((e) => e.distinct_id === userId && e.event === event);
/** Long enough for an event to have gone out if one was going to (flushAt 1, no interval). */
const settle = () => new Promise((r) => setTimeout(r, 300));
const until = async <T>(check: () => T | undefined | false, what: string, ms = 5_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
    const v = check();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

before(async () => {
  await prepareDb();
  horafirm = await fakeHorafirm();
  posthog = await fakeProvider(() => ({ json: { status: 1 } }));
  Object.assign(process.env, { DESKWISP_UPSTREAM_POSTHOG: posthog.url, DESKWISP_TELEMETRY: "1", DESKWISP_CLOUD_PLAN_SECRET: SECRET });
  cloud = await startCloud();
});

after(async () => {
  await shutdownTelemetry();
  await query("DELETE FROM deskwisp.plans WHERE user_id = ANY($1::text[])", [users]).catch(() => {});
  await query("DELETE FROM deskwisp.cloud_accounts WHERE user_id = ANY($1::text[])", [users]).catch(() => {});
  await dropUsers(users);
  await Promise.all([cloud?.close(), horafirm?.close(), posthog?.close()]);
  await closeDb();
});

beforeEach(() => {
  process.env.DESKWISP_TELEMETRY = "1";
});

const newUser = (what: string) => {
  const id = newUserId(`analytics-${what}`);
  users.push(id);
  return id;
};

/** horafirm-web's plan notice, signed as lib/billing/deskwisp-cloud-notify.ts signs it. */
async function notice(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}`;
  const r = await fetch(`${cloud.url}/v1/internal/plan-changed`, { method: "POST", headers: { "content-type": "application/json", "x-deskwisp-timestamp": ts, "x-deskwisp-signature": sig }, body: raw });
  return r.status;
}

test("a new user's first session is one deskwisp_signup_completed; a second session sends none", { skip: noProject }, async () => {
  const id = newUser("signup");
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: keyOf(id), headers: { "x-deskwisp-version": "0.0.22" } })).status, 200);
  const [e] = await until(() => {
    const l = of(id, "deskwisp_signup_completed");
    return l.length > 0 ? l : null;
  }, "deskwisp_signup_completed");
  assert.equal(e.properties.source, "cloud");
  assert.equal(e.properties.app, "deskwisp");
  assert.equal(e.properties.app_version, "0.0.22");
  assert.deepEqual(e.properties.$set_once, { deskwisp_plan: "free_deskwisp" });
  assert.ok(e.uuid, "counted once (horafirm-web's milestoneUuid)");
  assert.ok(!JSON.stringify(e).includes("@example.com"), "never the email");
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) })).status, 200);
  await settle();
  assert.equal(of(id, "deskwisp_signup_completed").length, 1);
});

test("a new user's session marked x-deskwisp-telemetry: off sends nothing", async () => {
  const id = newUser("off-header");
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: keyOf(id), headers: { "x-deskwisp-telemetry": "off" } })).status, 200);
  await settle();
  assert.equal(events().filter((e) => e.distinct_id === id).length, 0);
});

test("a free to pro notice is one deskwisp_plan_changed with the person's plan; the same notice again sends none", { skip: noProject }, async () => {
  const id = newUser("plan");
  const at = new Date().toISOString();
  assert.equal(await notice({ userId: id, tier: "pro_deskwisp", at }), 200);
  const [e] = await until(() => {
    const l = of(id, "deskwisp_plan_changed");
    return l.length > 0 ? l : null;
  }, "deskwisp_plan_changed");
  assert.equal(e.properties.from_plan, "free_deskwisp");
  assert.equal(e.properties.to_plan, "pro_deskwisp");
  assert.equal(e.properties.heard_via, "notice");
  assert.deepEqual(e.properties.$set, { deskwisp_plan: "pro_deskwisp" });
  assert.equal(await notice({ userId: id, tier: "pro_deskwisp", at }), 200);
  await settle();
  assert.equal(of(id, "deskwisp_plan_changed").length, 1);
});

test("a user whose state has analyticsOff sends nothing on a notice", async () => {
  const id = newUser("switched-off");
  await query("INSERT INTO deskwisp.app_state (user_id, state, version) VALUES ($1, $2::jsonb, 1)", [id, JSON.stringify({ analyticsOff: true })]);
  assert.equal(await notice({ userId: id, tier: "max_deskwisp", at: new Date().toISOString() }), 200);
  await settle();
  assert.equal(events().filter((e) => e.distinct_id === id).length, 0);
});

test("with DESKWISP_TELEMETRY unset, nothing is sent", async () => {
  delete process.env.DESKWISP_TELEMETRY;
  const id = newUser("unset");
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) })).status, 200);
  assert.equal(await notice({ userId: id, tier: "pro_deskwisp", at: new Date().toISOString() }), 200);
  await settle();
  assert.equal(events().filter((e) => e.distinct_id === id).length, 0);
});
