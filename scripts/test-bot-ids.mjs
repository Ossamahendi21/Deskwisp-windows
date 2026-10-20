// Main bots from before Deskwisp's own ids get Wispy ids (lib/bot-ids.ts), chosen as
// db/migrations/0015_wispy_ids.sql chooses them in the cloud. node scripts/test-bot-ids.mjs
import assert from "node:assert/strict";
const { oldBotIds, renameBotIds } = await import(new URL("../lib/bot-ids.ts", import.meta.url).href);

// Plain: wispy → wispy, everywhere it's named, whole ids only.
const a = { bots: [{ id: "wispy", isMain: true }], chats: [{ id: "bot:wispy" }], usage: [{ botId: "wispy" }], text: "wispyish, wispy_bot, Wispy" };
const ma = oldBotIds(a.bots);
assert.deepEqual([...ma], [["wispy", "wispy"]]);
assert.deepEqual(renameBotIds(a, ma), { bots: [{ id: "wispy", isMain: true }], chats: [{ id: "bot:wispy" }], usage: [{ botId: "wispy" }], text: "wispyish, wispy_bot, Wispy" });

// A workspace's Wispy has "wispy" already: the old one takes the next free id, as in the cloud.
const b = { bots: [{ id: "wispy" }, { id: "wispy" }], chats: [{ id: "bot:wispy" }, { id: "bot:wispy" }] };
const mb = oldBotIds(b.bots);
assert.deepEqual([...mb], [["wispy", "wispy-2"]]);
assert.deepEqual(renameBotIds(b, mb).chats, [{ id: "bot:wispy-2" }, { id: "bot:wispy" }]);

// wispy and wispy-2: each its own, "wispy" never eating into "wispy-2".
const c = { bots: [{ id: "wispy-2" }, { id: "wispy" }], chats: [{ id: "bot:wispy-2" }, { id: "bot:wispy" }] };
const mc = oldBotIds(c.bots);
assert.deepEqual([...mc], [["wispy", "wispy"], ["wispy-2", "wispy-2"]]);
assert.deepEqual(renameBotIds(c, mc), { bots: [{ id: "wispy-2" }, { id: "wispy" }], chats: [{ id: "bot:wispy-2" }, { id: "bot:wispy" }] });

// Nothing old: the same object back, untouched.
const d = { bots: [{ id: "wispy" }] };
assert.equal(oldBotIds(d.bots).size, 0);
assert.equal(renameBotIds(d, oldBotIds(d.bots)), d);
console.log("bot ids: ok");
