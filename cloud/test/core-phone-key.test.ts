import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { creditLeft } from "../credit.ts";
import { closeDb, query } from "../db.ts";
import { LEDGER_IN_USE, TEST_DATABASE_URL, call, dropUsers, fakeHorafirm, fakeProvider, keyOf, newNumber, prepareDb, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * Bots' numbers on the user's own AgentPhone account (cloud/phone-key.ts): the key is checked with
 * AgentPhone before it's kept, kept sealed, and then every AgentPhone call of theirs goes with it, in no
 * sub-account, with no AI credit asked or taken (counted at $0) and no plan limit. Forgetting it puts
 * them back on Deskwisp's account.
 */

const tag = randomUUID().slice(0, 8);
const users: string[] = [];
let horafirm: Listening, cloud: Listening;
let ledger: pg.Client;
let agentphone: Awaited<ReturnType<typeof fakeProvider>>;
const OWN = `ap_own_${tag}_0123456789abcdef`;
let n = 0;

async function newUser() {
  const id = randomUUID();
  users.push(id);
  await query("INSERT INTO public.profiles (id) VALUES ($1)", [id]);
  await seedUser(id, { subAccount: `sub_${id}` });
  return id;
}

/** Nothing left to spend: the one-time credit given and used up, no plan credit. */
async function noCredit(userId: string) {
  await creditLeft(userId);
  await query("UPDATE public.deskwisp_ai_credit SET free_micros = 0, plan_micros = 0, plan_expires_at = NULL WHERE user_id = $1", [userId]);
}

const usageOf = async (userId: string, kind: string) =>
  (await query<{ cost: number; detail: Record<string, unknown> }>("SELECT cost_micros::float8 AS cost, detail FROM deskwisp.cloud_usage WHERE user_id = $1 AND kind = $2 ORDER BY id", [userId, kind])).rows;
const as = (userId: string, method: string, path: string, json?: unknown) => call(cloud.url, method, path, { key: keyOf(userId), json });

/** horafirm-web's ledger, in this throwaway database (made by its owner, deskwisp_app here), one test file at a time. */
async function prepareLedger() {
  const sql = await readFile(fileURLToPath(new URL("./fixtures/horafirm-deskwisp-credit.sql", import.meta.url)), "utf8");
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('deskwisp-edge-tests'))");
    await c.query(sql);
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('deskwisp-edge-tests'))").catch(() => {});
    await c.end();
  }
}

before(async () => {
  await prepareDb();
  await prepareLedger();
  ledger = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await ledger.connect();
  await ledger.query("SELECT pg_advisory_lock_shared(hashtext($1))", [LEDGER_IN_USE]);
  process.env.DESKWISP_AI_CREDITS = "1";
  horafirm = await fakeHorafirm();
  // Deskwisp's key and the user's own are both good; anything else is refused, as AgentPhone does.
  agentphone = await fakeProvider((g) => {
    if (![`Bearer ${OWN}`, "Bearer ap-test-key"].includes(String(g.headers.authorization))) return { status: 401, json: { error: "invalid api key" } };
    if (g.method === "GET" && g.path === "/v1/numbers") return { json: { data: [], hasMore: false, total: 0 } };
    if (g.method === "POST" && g.path === "/v1/numbers") return { json: { id: `num_${tag}_${++n}`, phoneNumber: newNumber(), type: "sms" } };
    if (g.method === "POST" && g.path === "/v1/messages") return { json: { id: `msg_${tag}_${++n}`, status: "queued" } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  Object.assign(process.env, { AGENTPHONE_API_KEY: "ap-test-key", DESKWISP_UPSTREAM_AGENTPHONE: agentphone.url });
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM deskwisp.phone_keys WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [users]);
  await Promise.all([cloud?.close(), horafirm?.close(), agentphone?.close(), ledger?.end()]);
  await closeDb();
});

test("a key is kept only once AgentPhone takes it, sealed, and shown by its last four", async () => {
  const u = await newUser();
  assert.deepEqual((await as(u, "GET", "/v1/phone/key")).json.connected, false);
  const odd = await as(u, "PUT", "/v1/phone/key", { key: "not a key" });
  assert.equal(odd.status, 400);
  assert.match(odd.json.error, /doesn't look like an AgentPhone API key/);
  const refused = await as(u, "PUT", "/v1/phone/key", { key: `ap_wrong_${tag}_0123456789abcdef` });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /didn't accept that key/);
  assert.equal((await query("SELECT 1 FROM deskwisp.phone_keys WHERE user_id = $1", [u])).rowCount, 0);

  const ok = await as(u, "PUT", "/v1/phone/key", { key: `  ${OWN}\n` });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { connected: true, last4: OWN.slice(-4) });
  const kept = (await query<{ key_sealed: string }>("SELECT key_sealed FROM deskwisp.phone_keys WHERE user_id = $1", [u])).rows[0];
  assert.ok(kept.key_sealed.startsWith("v1:") && !kept.key_sealed.includes(OWN), "sealed, never as it is");
  const read = await as(u, "GET", "/v1/phone/key");
  assert.equal(read.json.connected, true);
  assert.equal(read.json.last4, OWN.slice(-4));
  assert.ok(!read.text.includes(OWN), "the key itself never goes back");
});

test("with their own key: no sub-account, no credit asked or taken, and the session says so", async () => {
  const u = await newUser();
  await noCredit(u);
  assert.equal((await as(u, "PUT", "/v1/phone/key", { key: OWN })).status, 200);
  const session = await as(u, "POST", "/v1/session");
  assert.equal(session.status, 200, session.text);
  assert.equal(session.json.agentphone.own, true);
  assert.equal(session.json.agentphone.subAccountId, null);

  const bought = await as(u, "POST", "/proxy/agentphone/v1/numbers", { country: "US", areaCode: "415", type: "sms" });
  assert.equal(bought.status, 200, bought.text);
  const sent = agentphone.got.at(-1)!;
  assert.equal(sent.headers.authorization, `Bearer ${OWN}`);
  assert.equal(sent.headers["x-sub-account-id"], undefined);
  const row = await until(async () => (await usageOf(u, "agentphone.numbers"))[0]);
  assert.deepEqual([row.cost, row.detail.ownKey], [0, true]);

  assert.equal((await as(u, "POST", "/proxy/agentphone/v1/messages", { agent_id: "a", number_id: "n", to_number: "+14155550100", body: "hi" })).status, 200);
  const text = await until(async () => (await usageOf(u, "agentphone.sms"))[0]);
  assert.deepEqual([text.cost, text.detail.ownKey], [0, true]);
  assert.equal(await creditLeft(u), 0);
  // Naming a sub-account is still refused.
  assert.equal((await as(u, "GET", "/proxy/agentphone/v1/numbers?subAccountId=sub_someone")).status, 400);
});

test("forgetting the key puts the user back on Deskwisp's account, with its credit and sub-account", async () => {
  const u = await newUser();
  await noCredit(u);
  assert.equal((await as(u, "PUT", "/v1/phone/key", { key: OWN })).status, 200);
  assert.equal((await as(u, "DELETE", "/v1/phone/key")).json.connected, false);
  assert.equal((await query("SELECT 1 FROM deskwisp.phone_keys WHERE user_id = $1", [u])).rowCount, 0);
  const bought = await as(u, "POST", "/proxy/agentphone/v1/numbers", { country: "US", areaCode: "415", type: "sms" });
  assert.equal(bought.status, 402, bought.text);
  assert.equal((await as(u, "GET", "/proxy/agentphone/v1/numbers")).status, 200);
  const sent = agentphone.got.at(-1)!;
  assert.equal(sent.headers.authorization, "Bearer ap-test-key");
  assert.equal(sent.headers["x-sub-account-id"], `sub_${u}`);
});
