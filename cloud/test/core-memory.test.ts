import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { memoryBlock } from "../honcho.ts";
import { search } from "../memory.ts";
import { call, dropUsers, fakeHorafirm, keyOf, prepareDb, seedUser, startCloud, type Listening } from "./core-fakes.ts";

/**
 * Deskwisp's own memory (cloud/memory.ts): each user's banks, their facts and card, kept here so the PC,
 * the cloud's own answers and the phone all read the same. Only the user's own; a bank name that isn't
 * one is refused; the session says it's here; without Honcho, the cloud's own answers read it.
 */

const users: string[] = [];
let horafirm: Listening, cloud: Listening;

async function newUser() {
  const id = randomUUID();
  users.push(id);
  await seedUser(id);
  return id;
}
const as = (userId: string, method: string, path: string, json?: unknown) => call(cloud.url, method, path, { key: keyOf(userId), json });

before(async () => {
  await prepareDb();
  delete process.env.HONCHO_API_KEY;
  horafirm = await fakeHorafirm();
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM deskwisp.memory_facts WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM deskwisp.memory_cards WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await Promise.all([cloud?.close(), horafirm?.close()]);
  await closeDb();
});

test("facts: added, listed newest first a page at a time, found by their words, read and taken out", async () => {
  const u = await newUser();
  const empty = await as(u, "GET", "/v1/memory/deskwisp");
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json, { lines: [], pinned: [], total: 0 });
  const made = await as(u, "POST", "/v1/memory/deskwisp/facts", {
    items: [
      { content: "The user's partner is Sara." },
      { content: "The user runs Atlas Bakery in Casablanca.", sessionId: "deskwisp-chat-bot-wispy" },
      { content: "  " },
      { content: "x".repeat(2000) },
    ],
  });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json.items.length, 3, "an empty one is left out");
  assert.equal(made.json.items[2].content.length, 1000, "cut to 1000");
  const all = await as(u, "GET", "/v1/memory/deskwisp/facts?size=2");
  assert.equal(all.json.total, 3);
  assert.equal(all.json.items.length, 2);
  const next = await as(u, "GET", "/v1/memory/deskwisp/facts?size=2&offset=2");
  assert.equal(next.json.items.length, 1);
  const mine = await as(u, "GET", "/v1/memory/deskwisp/facts?sessions=deskwisp-chat-bot-wispy");
  assert.deepEqual(mine.json.items.map((f: { content: string }) => f.content), ["The user runs Atlas Bakery in Casablanca."]);
  const found = await as(u, "GET", `/v1/memory/deskwisp/search?q=${encodeURIComponent("who is Sara")}&k=3`);
  assert.equal(found.json.items[0].content, "The user's partner is Sara.");
  const id = found.json.items[0].id;
  assert.equal((await as(u, "POST", "/v1/memory/deskwisp/facts/get", { ids: [id] })).json.items[0].id, id);
  assert.equal((await as(u, "POST", "/v1/memory/deskwisp/facts/delete", { ids: [id] })).json.deleted, 1);
  assert.equal((await as(u, "GET", "/v1/memory/deskwisp")).json.total, 2);
});

test("the card: kept with what was pinned (only lines on it), at most 40", async () => {
  const u = await newUser();
  const put = await as(u, "PUT", "/v1/memory/deskwisp-ws_2/card", { lines: ["The user's name is Ossama.", "The user likes tea.", ...Array.from({ length: 50 }, (_, i) => `Line ${i}`)], pinned: ["The user's name is Ossama.", "Not on the card"] });
  assert.equal(put.status, 200, put.text);
  const got = await as(u, "GET", "/v1/memory/deskwisp-ws_2");
  assert.equal(got.json.lines.length, 40);
  assert.deepEqual(got.json.pinned, ["The user's name is Ossama."]);
});

test("only the user's own; a bank name that isn't one is refused", async () => {
  const a = await newUser();
  const b = await newUser();
  await as(a, "POST", "/v1/memory/deskwisp/facts", { items: [{ content: "A's secret plan is the spring launch." }] });
  const id = (await as(a, "GET", "/v1/memory/deskwisp/facts")).json.items[0].id;
  assert.equal((await as(b, "GET", "/v1/memory/deskwisp")).json.total, 0);
  assert.deepEqual((await as(b, "GET", "/v1/memory/deskwisp/search?q=spring")).json.items, []);
  assert.deepEqual((await as(b, "POST", "/v1/memory/deskwisp/facts/get", { ids: [id] })).json.items, []);
  assert.equal((await as(b, "POST", "/v1/memory/deskwisp/facts/delete", { ids: [id] })).json.deleted, 0);
  assert.equal((await as(a, "GET", "/v1/memory/deskwisp")).json.total, 1, "still there for its owner");
  assert.equal((await as(a, "GET", "/v1/memory/..%2F..%2Fetc")).status, 400);
  assert.equal((await as(a, "GET", "/v1/memory/deskwisp/nothing")).status, 404);
  assert.equal((await call(cloud.url, "GET", "/v1/memory/deskwisp")).status, 401, "signed in only");
});

test("the session says it's here; without Honcho, the cloud's own answers read it", async () => {
  const u = await newUser();
  const s = await as(u, "POST", "/v1/session");
  assert.equal(s.json.memory, true, s.text);
  assert.equal(s.json.honcho, null);
  await as(u, "PUT", "/v1/memory/deskwisp/card", { lines: ["The user's name is Ossama."] });
  await as(u, "POST", "/v1/memory/deskwisp/facts", { items: [{ content: "The user prefers flights before noon." }, { content: "The user's dog is Max." }] });
  const block = await memoryBlock(u, { bank: "deskwisp", peer: "user" }, "book me a flight to Paris", "Ossama");
  assert.match(block, /About Ossama:\n- The user's name is Ossama\./);
  assert.match(block, /flights before noon/);
  assert.doesNotMatch(block, /dog/, "only what bears on what was said");
});

test("search: rarer words count for more; only common words find nothing", () => {
  const f = (content: string, at = "2026-10-01T00:00:00Z") => ({ content, createdAt: at });
  const facts = [f("The user likes the color blue."), f("The user works with Karim on invoices."), f("The user likes the beach.")];
  assert.equal(search(facts, "what does the user do with Karim", 3)[0].content, "The user works with Karim on invoices.");
  assert.deepEqual(search(facts, "the", 3), []);
  assert.equal(search([f("Ossama aime le café noir.")], "cafe", 1).length, 1, "accents don't matter");
});
