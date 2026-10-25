// Tests for memory without Honcho (lib/server/local-memory.ts, used by lib/server/memory.ts when
// neither Deskwisp Cloud nor this server has Honcho): it's on for whoever is signed in here; a fact
// saved is listed, found by its words (rarer words count for more, any language), given to a bot with
// a message it bears on, and kept in a file that's read back after a restart;
// a question is answered by a model from the closest facts; the card is written from the facts
// and keeps what was pinned; forgetting takes a fact out. OpenAI is a fake: nothing reaches the network.
// Usage: node --conditions=react-server scripts/test-memory-local.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(DESKWISP|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|HORAFIRM|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.DESKWISP_SELF_HOSTED = "1";
process.env.DESKWISP_HORAFIRM_ORIGIN = "https://horafirm.test";
process.env.OPENAI_API_KEY = "sk-test-memory";
globalThis.deskwispHorafirmKey = "sk_horafirm_test_memory";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "deskwisp-test-memory-"));
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});

/** The model: what each call is answered with depends on what it's asked. */
const asked = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    asked.push(b);
    const text = /keep .*'s card/.test(b.instructions ?? "")
      ? "The user runs Atlas Bakery in Casablanca.\nThe user's partner is Sara."
      : /Answer a question about/.test(b.instructions ?? "")
        ? b.input.includes("Sara") ? "Their partner is Sara." : "It isn't known yet."
        : // Jev's stand-in: a JSON answer that says nothing is the same.
          JSON.stringify({});
    return new Response(JSON.stringify({ id: `resp_${asked.length}`, object: "response", model: "gpt-test", status: "completed", output: [{ id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.origin === "https://horafirm.test") return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
console.warn = () => {};

const M = await import(`${root}/lib/server/memory.ts`);
const LM = await import(`${root}/lib/server/local-memory.ts`);
const Api = await import(`${root}/app/api/memory/route.ts`);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${e.stack}`);
  }
}
const get = async (q) => (await Api.GET(new Request(`http://localhost:3210/api/memory?${q}`))).json();

await test("on without Honcho, and the Memory tab works", async () => {
  assert.equal(M.memoryOn(), true);
  const r = await get("bot=wispy");
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.facts, []);
});

await test("save, list, find by words", async () => {
  assert.equal(await M.learn("ws_main", "The user's partner is Sara."), "Saved.");
  assert.equal(await M.learn("ws_main", "The user runs Atlas Bakery in Casablanca."), "Saved.");
  assert.equal(await M.learn("ws_main", "The user prefers flights before noon."), "Saved.");
  assert.equal(await M.learn("ws_main", "L'utilisateur aime le café noir."), "Saved.");
  const r = await get("bot=wispy");
  assert.equal(r.facts.length, 4);
  assert.equal(r.facts[0].source, "Saved by hand");
  const found = await get("bot=wispy&q=" + encodeURIComponent("who is Sara?"));
  assert.equal(found.facts[0].text, "The user's partner is Sara.");
  const fr = await get("bot=wispy&q=" + encodeURIComponent("café"));
  assert.equal(fr.facts[0].text, "L'utilisateur aime le café noir.", "accents and another language");
  const block = await M.memoryBlock("ws_main", "book me a flight to Paris");
  assert.match(block, /flights before noon/);
  assert.doesNotMatch(block, /Atlas Bakery/, "only what bears on the message (with an empty card)");
});

await test("search weighs rare words over common ones", () => {
  const f = (id, content) => ({ id, content, sessionId: null, createdAt: new Date().toISOString(), level: "explicit" });
  const facts = [f("1", "The user likes the color blue."), f("2", "The user works with Karim on invoices."), f("3", "The user likes the beach.")];
  assert.equal(LM.search(facts, "what does the user do with Karim", 3)[0].id, "2");
  assert.deepEqual(LM.search(facts, "the", 3), [], "only stop words: nothing");
});

await test("a question is answered from the closest facts", async () => {
  const before = asked.length;
  const r = await (await Api.POST(new Request("http://localhost:3210/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ask", bot: "wispy", question: "Who is my partner?" }) }))).json();
  assert.equal(r.answer, "Their partner is Sara.");
  assert.ok(asked.slice(before).some((b) => /Answer a question about/.test(b.instructions) && b.input.includes("Sara")));
});

await test("the card: written from the facts, pinned lines kept, in the bots' prompts", async () => {
  await M.pinFact("ws_main", "The user's name is Ossama.");
  await M.dream("ws_main");
  const card = await M.cardOf("ws_main");
  assert.deepEqual(card, ["The user's name is Ossama.", "The user runs Atlas Bakery in Casablanca.", "The user's partner is Sara."]);
  const block = await M.memoryBlock("ws_main", "hello", 2500, { search: false });
  assert.match(block, /Ossama/);
  assert.match(block, /Atlas Bakery/);
});

await test("kept in a file, read back after a restart; forgetting takes a fact out", async () => {
  const dir = join(work, ".data");
  const files = readdirSync(join(dir, "memory"));
  assert.deepEqual(files, ["deskwisp.json"]);
  const kept = JSON.parse(readFileSync(join(dir, "memory", "deskwisp.json"), "utf8"));
  assert.equal(kept.facts.length, 4);
  // A fresh process: nothing in memory but the file.
  delete globalThis.deskwispLocalMemory;
  const again = LM.localMemoryClient(dir, "deskwisp");
  assert.equal((await again.conclusions.list({ size: 10 })).total, 4);
  const sara = (await again.conclusions.query("Sara", 1))[0];
  await M.forgetFact("ws_main", sara.id);
  const r = await get("bot=wispy");
  assert.ok(!r.facts.some((x) => x.text.includes("Sara")));
  assert.ok(existsSync(join(dir, "memory", "deskwisp.json")));
});

rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
process.exit(0);
