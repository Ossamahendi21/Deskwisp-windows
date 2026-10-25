// Tests for Deskwisp's own memory kept on Deskwisp Cloud (lib/server/local-memory.ts cloudStore, used
// by lib/server/memory.ts when the cloud's session says it keeps memory and there's no Honcho): what the
// app saves, lists, searches, pins, asks and forgets goes to /v1/memory/<bank> on the cloud, under the
// signed-in user's key, and nothing is written on this PC. The cloud is a fake that keeps the facts in
// memory and searches them with cloud/memory.ts's own search; OpenAI is a fake too.
// Usage: node --conditions=react-server scripts/test-memory-cloud.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(DESKWISP|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|HORAFIRM|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.DESKWISP_HORAFIRM_ORIGIN = "https://horafirm.test";
process.env.DESKWISP_CLOUD_URL = "https://cloud.test/api";
const KEY = "sk_horafirm_test_memory_cloud";
globalThis.deskwispHorafirmKey = KEY;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "deskwisp-test-memory-cloud-"));
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

const { search } = await import(`${root}/cloud/memory.ts`);

/** The cloud: its session, its memory (kept here), its OpenAI proxy. */
const banks = new Map();
const bankOf = (name) => {
  if (!banks.has(name)) banks.set(name, { lines: [], pinned: [], facts: [] });
  return banks.get(name);
};
const seen = [];
let n = 0;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const body = req.method === "GET" ? null : await req.text();
  if (url.origin === "https://cloud.test") {
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/v1/session") return json({ userId: "u_cloud", email: "owner@example.com", memory: true, honcho: null, composio: null, openai: { executorKey: null }, typesafe: false, verify: { sms: false, email: false }, slack: null, agentmail: null, agentphone: null });
    if (path === "/proxy/openai/v1/responses") {
      const b = JSON.parse(body);
      const text = /keep .*'s card/.test(b.instructions ?? "") ? "The user runs Atlas Bakery.\nThe user's partner is Sara." : /Answer a question about/.test(b.instructions ?? "") ? (b.input.includes("Sara") ? "Their partner is Sara." : "It isn't known yet.") : JSON.stringify({});
      return json({ id: "r", object: "response", model: "gpt-test", status: "completed", output: [{ id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    }
    const m = /^\/v1\/memory\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const b = bankOf(decodeURIComponent(m[1]));
      const rest = m[2] ?? "";
      const j = body ? JSON.parse(body) : {};
      const newest = () => [...b.facts].sort((x, y) => (y.n - x.n));
      const out = ({ n: _n, ...f }) => f;
      if (req.method === "GET" && rest === "") return json({ lines: b.lines, pinned: b.pinned, total: b.facts.length });
      if (req.method === "PUT" && rest === "/card") return (b.lines = j.lines, b.pinned = j.pinned.filter((l) => j.lines.includes(l)), json({ lines: b.lines, pinned: b.pinned }));
      if (req.method === "GET" && rest === "/facts") {
        const size = Number(url.searchParams.get("size") ?? 100), offset = Number(url.searchParams.get("offset") ?? 0);
        const only = url.searchParams.get("sessions")?.split(",");
        const all = newest().filter((f) => !only || only.includes(f.sessionId));
        return json({ items: all.slice(offset, offset + size).map(out), total: all.length });
      }
      if (req.method === "GET" && rest === "/search") return json({ items: search(newest(), url.searchParams.get("q") ?? "", Number(url.searchParams.get("k") ?? 10)).map(out) });
      if (req.method === "POST" && rest === "/facts") {
        const made = j.items.map((i) => ({ id: `mf_${++n}`, n, content: i.content, sessionId: i.sessionId ?? null, createdAt: new Date(Date.now() + n).toISOString(), level: "explicit" }));
        b.facts.push(...made);
        return json({ items: made.map(out) });
      }
      if (req.method === "POST" && rest === "/facts/get") return json({ items: b.facts.filter((f) => j.ids.includes(f.id)).map(out) });
      if (req.method === "POST" && rest === "/facts/delete") {
        const before = b.facts.length;
        b.facts = b.facts.filter((f) => !j.ids.includes(f.id));
        return json({ deleted: before - b.facts.length });
      }
    }
    return json({ error: "not faked" }, 404);
  }
  if (url.origin === "https://horafirm.test") return json({ error: "not faked" }, 404);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
console.warn = () => {};

const Cloud = await import(`${root}/lib/server/cloud.ts`);
const M = await import(`${root}/lib/server/memory.ts`);

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

await Cloud.cloudSession(true);

await test("signed in, memory is the cloud's: saved there under the user's key, nothing on this PC", async () => {
  assert.equal(M.memoryOn(), true);
  assert.equal(await M.learn("ws_main", "The user's partner is Sara."), "Saved.");
  assert.equal(await M.learn("ws_main", "The user prefers flights before noon."), "Saved.");
  assert.deepEqual(bankOf("deskwisp").facts.map((f) => f.content), ["The user's partner is Sara.", "The user prefers flights before noon."]);
  assert.ok(seen.filter((s) => s.path.startsWith("/api/v1/memory/")).every((s) => s.auth === `Bearer ${KEY}`));
  assert.ok(!existsSync(join(work, ".data", "memory")), "no file on this PC");
});

await test("listed, searched and given to a bot from the cloud", async () => {
  const r = await M.memoryFor("wispy");
  assert.deepEqual(r.facts.map((f) => f.text), ["The user prefers flights before noon.", "The user's partner is Sara."]);
  const found = await M.memoryFor("wispy", { q: "Sara" });
  assert.equal(found.facts[0].text, "The user's partner is Sara.");
  assert.match(await M.memoryBlock("ws_main", "book a flight to Paris"), /flights before noon/);
});

await test("a question, the card (pinned lines kept), and forgetting, all on the cloud", async () => {
  const a = await M.askMemory("wispy", "Who is my partner?");
  assert.equal(a.answer, "Their partner is Sara.");
  await M.pinFact("ws_main", "The user's name is Ossama.");
  await M.dream("ws_main");
  assert.deepEqual(bankOf("deskwisp").lines, ["The user's name is Ossama.", "The user runs Atlas Bakery.", "The user's partner is Sara."]);
  assert.deepEqual(bankOf("deskwisp").pinned, ["The user's name is Ossama."]);
  const sara = bankOf("deskwisp").facts.find((f) => f.content.includes("Sara"));
  await M.forgetFact("ws_main", sara.id);
  assert.ok(!bankOf("deskwisp").facts.some((f) => f.content.includes("Sara")));
});

rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
process.exit(0);
