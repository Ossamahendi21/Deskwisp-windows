import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import OpenAI from "openai";
import { closeDb, query } from "../db.ts";
import { recordTier } from "../plans.ts";
import { dropUsers, fakeHorafirm, fakeProvider, keyOf, newUserId, prepareDb, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * Free's bots run on its cheap model (config.freeModel, proxy.ts freeModel), whatever the app asks for:
 * a chat answer and a task alike, priced at that model. A paid plan runs on what's asked.
 */

process.env.DESKWISP_FREE_MODEL = "gpt-6-luna";
const tag = randomUUID().slice(0, 8);
const free = newUserId("free");
const pro = newUserId("pro");
let horafirm: Listening, cloud: Listening, openai: Awaited<ReturnType<typeof fakeProvider>>;
let n = 0;

const sdk = (userId: string) => new OpenAI({ apiKey: keyOf(userId), baseURL: `${cloud.url}/proxy/openai/v1`, maxRetries: 0 });
const costOf = async (ref: string) =>
  (await query("SELECT cost_micros::float8 AS cost, detail->>'model' AS model FROM deskwisp.cloud_usage WHERE kind = 'openai.tokens' AND detail->>'ref' = $1", [ref])).rows;

before(async () => {
  await prepareDb();
  await Promise.all([seedUser(free), seedUser(pro)]);
  await recordTier(pro, "pro_deskwisp", new Date(), "notice");
  horafirm = await fakeHorafirm();
  openai = await fakeProvider(async (g) => {
    if (g.method === "POST" && g.path === "/v1/responses") {
      const id = `resp_${tag}_${++n}`;
      return { json: { id, object: "response", model: g.json?.model, output: [], usage: { input_tokens: 100_000, output_tokens: 100_000 } } };
    }
    if (g.method === "POST" && g.path === "/v1/agents/sessions") return { json: { id: `asess_${tag}_${++n}`, object: "agent.session" } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-main", DESKWISP_UPSTREAM_OPENAI: openai.url });
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM deskwisp.plans WHERE user_id = $1", [pro]);
  await dropUsers([free, pro]);
  await Promise.all([cloud?.close(), horafirm?.close(), openai?.close()]);
  await closeDb();
});

test("on Free, an answer asked of any model is made with Free's, and priced at it", async () => {
  const r = await sdk(free).responses.create({ model: "gpt-6-astra", input: "hello" });
  assert.equal(openai.got.at(-1)!.json.model, "gpt-6-luna");
  // 100K tokens in and out at $0.10 and $0.50 a million.
  assert.deepEqual(await until(() => costOf(r.id).then((x) => x.length && x)), [{ cost: 60_000, model: "gpt-6-luna" }]);
});

test("on Free, a task runs on Free's model too", async () => {
  await sdk(free).post("/agents/sessions", { body: { agent: { model: "gpt-6-astra", instructions: "do it" } } });
  assert.equal(openai.got.at(-1)!.json.agent.model, "gpt-6-luna");
});

test("a paid plan runs on the model it asks for", async () => {
  await sdk(pro).responses.create({ model: "gpt-6.1-sol", input: "hello" });
  assert.equal(openai.got.at(-1)!.json.model, "gpt-6.1-sol");
});
