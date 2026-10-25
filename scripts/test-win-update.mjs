// The Windows app's updater (desktop/win-update.cjs) against a local stand-in for deskwisp.com/download/win:
// its states, as About and the update screen see them; it only keeps an installer whose size and SHA-512
// are latest.json's; it offers one left from before at launch; it runs it as electron-builder's updater
// does, and with its window when that didn't finish the update. node --test scripts/test-win-update.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createUpdater, isNewer, readLatest } = require("../desktop/win-update.cjs");

const exe = Buffer.from("MZ pretend installer ".repeat(5000));
const sha = (b) => crypto.createHash("sha512").update(b).digest("base64");

async function site(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const r = routes[req.url];
    if (!r) return res.writeHead(404).end();
    res.writeHead(200).end(typeof r === "function" ? r() : r);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/download/win/`;
  return { base, hits, close: () => new Promise((r) => server.close(r)) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dw-upd-"));
const latest = (o = {}) => JSON.stringify({ version: "0.2.0", file: "Deskwisp-Setup-0.2.0-x64.exe", sha512: sha(exe), size: exe.length, notes: ["Updates itself", " ", 3], ...o });
const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never: ${what}`);
};
const updater = (s, dir, o = {}) => {
  const seen = [];
  const runs = [];
  const u = createUpdater({
    currentVersion: "0.1.0",
    dir,
    logFile: path.join(path.dirname(dir), `${path.basename(dir)}.log`),
    latestUrl: s.base + "latest.json",
    onChange: (st) => seen.push(st),
    spawnImpl: (file, args, opts) => (runs.push({ file, args, opts }), { unref() {} }),
    ...o,
  });
  return { u, seen, runs, log: () => fs.readFileSync(path.join(path.dirname(dir), `${path.basename(dir)}.log`), "utf8") };
};

test("versions", () => {
  assert.equal(isNewer("0.2.0", "0.1.9"), true);
  assert.equal(isNewer("0.1.10", "0.1.9"), true);
  assert.equal(isNewer("v1.0.0", "1.0.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
});

test("latest.json is read strictly", () => {
  const u = "https://deskwisp.com/download/win/latest.json";
  assert.equal(readLatest(JSON.parse(latest()), u).url, "https://deskwisp.com/download/win/Deskwisp-Setup-0.2.0-x64.exe");
  assert.match(readLatest(JSON.parse(latest({ file: "https://evil.example/Deskwisp-Setup-0.2.0-x64.exe" })), u).problem, /installer/);
  assert.match(readLatest(JSON.parse(latest({ file: "../x.exe" })), u).problem, /installer/);
  assert.match(readLatest(JSON.parse(latest({ sha512: "abc" })), u).problem, /SHA-512/);
  assert.match(readLatest(JSON.parse(latest({ size: 0 })), u).problem, /size/);
  assert.match(readLatest({}, u).problem, /version/);
});

test("a newer release: checking, downloading with progress, ready, then run silently", async () => {
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Deskwisp-Setup-0.1.0-x64.exe"), "old");
  const { u, seen, runs } = updater(s, dir);
  assert.equal(u.status().state, "idle");
  // It answers at once: found, and (downloads being automatic) already coming down.
  const answer = await u.check();
  assert.equal(answer.state, "downloading");
  assert.equal(answer.version, "0.2.0");
  await until(() => u.status().state === "ready", "ready");
  const states = seen.map((x) => x.state);
  assert.deepEqual([...new Set(states)], ["checking", "available", "downloading", "ready"]);
  assert.ok(seen.some((x) => x.state === "downloading" && x.progress >= 0 && x.progress <= 1));
  const st = u.status();
  assert.deepEqual({ state: st.state, version: st.version, notes: st.notes, current: st.current }, { state: "ready", version: "0.2.0", notes: ["Updates itself"], current: "0.1.0" });
  assert.ok(st.checkedAt > 0);
  // The installer, and who it is next to it; the old one's gone.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["Deskwisp-Setup-0.2.0-x64.exe", "Deskwisp-Setup-0.2.0-x64.exe.json"]);
  assert.deepEqual(fs.readFileSync(path.join(dir, "Deskwisp-Setup-0.2.0-x64.exe")), exe);

  // Checking again while ready doesn't ask or download again.
  await u.check();
  assert.equal(s.hits.filter((h) => h.endsWith(".exe")).length, 1);
  assert.equal(s.hits.filter((h) => h.endsWith(".json")).length, 1);

  assert.equal(u.install({ reopen: true }), true);
  assert.deepEqual(runs[0].args, ["--updated"], "with its window: only the progress shows");
  assert.equal(runs[0].file, path.join(dir, "Deskwisp-Setup-0.2.0-x64.exe"));
  assert.equal(runs[0].opts.detached, true);
  assert.equal(u.install({ reopen: false }), false, "once is enough");
  await s.close();
});

test("the installer is started straight, in its own folder; one that didn't finish runs with its window next time", async () => {
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  const first = updater(s, dir);
  await first.u.check();
  await until(() => first.u.status().state === "ready", "ready");
  assert.equal(first.u.status().retry, undefined);
  assert.equal(first.u.install({ reopen: true }), true);
  const installer = path.join(dir, "Deskwisp-Setup-0.2.0-x64.exe");
  assert.equal(first.runs[0].file, installer, "no script in between");
  assert.deepEqual(first.runs[0].args, ["--updated"]);
  assert.equal(first.runs[0].opts.cwd, dir, "never in Deskwisp's folder");
  assert.equal(first.runs[0].opts.detached, true);
  assert.equal(JSON.parse(fs.readFileSync(`${installer}.json`, "utf8")).tried.from, "0.1.0");
  assert.match(first.log(), /started the installer/);
  await s.close();

  // The next launch is still 0.1.0: it didn't finish. Offered again, and this time with its window.
  const again = updater(s, dir);
  assert.equal(await again.u.restore(), true);
  assert.equal(again.u.status().retry, true);
  assert.match(again.log(), /didn't finish installing/);
  assert.equal(again.u.install({ reopen: true }), true);
  assert.deepEqual(again.runs[0].args, ["--updated"]);
  assert.equal(again.runs[0].opts.windowsHide, false);

  // Updated after all: nothing to offer.
  const after = updater(s, dir, { currentVersion: "0.2.0" });
  assert.equal(await after.u.restore(), false);
  assert.equal(after.u.status().retry, undefined);
});

test("with automatic downloads off, it waits for Download", async () => {
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  let auto = false;
  const { u } = updater(s, dir, { auto: () => auto });
  assert.equal((await u.check()).state, "available");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(u.status().state, "available");
  assert.equal(u.status().auto, false);
  assert.equal(s.hits.filter((h) => h.endsWith(".exe")).length, 0);
  assert.equal(await u.download(), true);
  assert.equal(u.status().state, "ready");
  auto = true;
  assert.equal(u.status().auto, true);
  await s.close();
});

test("an installer that isn't latest.json's is thrown away and the state says so", async () => {
  const bad = Buffer.from(exe);
  bad[10] ^= 1;
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": bad });
  const dir = tmp();
  const { u, log } = updater(s, dir);
  await u.check();
  await until(() => u.status().state === "error", "error");
  assert.equal(u.status().version, "0.2.0");
  assert.match(u.status().error, /didn't finish/);
  assert.equal(u.isReady(), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(log(), /SHA-512/);
  assert.equal(u.install({ reopen: true }), false);
  await s.close();
});

test("too big is cut off; up to date says so, with this version's notes; no site is an error in words", async () => {
  const s = await site({ "/download/win/latest.json": latest({ size: 100 }), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  const { u, log } = updater(s, dir);
  await u.check();
  await until(() => u.status().state === "error", "error");
  assert.match(log(), /bigger/);
  await s.close();

  const s2 = await site({ "/download/win/latest.json": latest({ version: "0.1.0", file: "Deskwisp-Setup-0.1.0-x64.exe" }) });
  const { u: u2 } = updater(s2, dir);
  const st = await u2.check();
  assert.equal(st.state, "latest");
  assert.deepEqual(st.currentNotes, ["Updates itself"]);
  assert.equal(st.version, undefined);
  await s2.close();

  const { u: u3 } = updater(s2, dir);
  const st3 = await u3.check();
  assert.equal(st3.state, "error");
  assert.match(st3.error, /internet connection/);
});

test("at launch, an installer downloaded before is offered, if it's still whole and newer", async () => {
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  const first = updater(s, dir);
  await first.u.check();
  await until(() => first.u.status().state === "ready", "ready");
  await s.close();

  // Deskwisp closed without installing it (Windows shut down): the next launch finds it.
  const again = updater(s, dir);
  assert.equal(await again.u.restore(), true);
  assert.equal(again.u.status().state, "ready");
  assert.equal(again.u.status().version, "0.2.0");
  assert.deepEqual(again.u.status().notes, ["Updates itself"]);
  assert.equal(again.u.install({ reopen: true }), true);

  // Already on that version: nothing to offer, and it's cleared away.
  const after = updater(s, dir, { currentVersion: "0.2.0" });
  assert.equal(await after.u.restore(), false);
  assert.deepEqual(fs.readdirSync(dir), []);

  // Changed on disk since: not offered.
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, "Deskwisp-Setup-0.2.0-x64.exe"), Buffer.concat([exe.subarray(1), Buffer.from("x")]));
  fs.writeFileSync(path.join(dir2, "Deskwisp-Setup-0.2.0-x64.exe.json"), JSON.stringify({ version: "0.2.0", sha512: sha(exe), size: exe.length }));
  assert.equal(await updater(s, dir2).u.restore(), false);
});
