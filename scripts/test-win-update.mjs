// The Windows app's updater (desktop/win-update.cjs) against a local stand-in for deskwisp.com/download/win:
// it only keeps an installer whose size and SHA-512 are latest.json's, and runs it as electron-builder's
// updater does. node --test scripts/test-win-update.mjs
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

test("a newer release comes down, is checked, and is run silently", async () => {
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe });
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Deskwisp-Setup-0.1.0-x64.exe"), "old");
  const changes = [];
  const runs = [];
  const u = createUpdater({
    currentVersion: "0.1.0",
    dir,
    logFile: path.join(dir, "..", path.basename(dir) + ".log"),
    latestUrl: s.base + "latest.json",
    onChange: (i) => changes.push(i),
    spawnImpl: (file, args, opts) => (runs.push({ file, args, opts }), { unref() {} }),
  });
  assert.equal(u.info(), null);
  await u.check();
  assert.deepEqual(u.info(), { version: "0.2.0", notes: ["Updates itself"], ready: true });
  assert.deepEqual(changes, [{ version: "0.2.0", notes: ["Updates itself"], ready: true }]);
  assert.deepEqual(fs.readdirSync(dir), ["Deskwisp-Setup-0.2.0-x64.exe"]);
  assert.deepEqual(fs.readFileSync(path.join(dir, "Deskwisp-Setup-0.2.0-x64.exe")), exe);

  // Checking again doesn't download again.
  await u.check();
  assert.equal(s.hits.filter((h) => h.endsWith(".exe")).length, 1);
  assert.equal(changes.length, 1);

  assert.equal(u.install({ reopen: true }), true);
  assert.deepEqual(runs[0].args, ["--updated", "/S", "--force-run"]);
  assert.equal(runs[0].file, path.join(dir, "Deskwisp-Setup-0.2.0-x64.exe"));
  assert.equal(runs[0].opts.detached, true);
  // Once is enough.
  assert.equal(u.install({ reopen: false }), false);
  await s.close();
});

test("an installer that isn't latest.json's is thrown away, and the notice sends you to the site", async () => {
  const bad = Buffer.from(exe);
  bad[10] ^= 1;
  const s = await site({ "/download/win/latest.json": latest(), "/download/win/Deskwisp-Setup-0.2.0-x64.exe": bad });
  const dir = tmp();
  const u = createUpdater({ currentVersion: "0.1.0", dir, logFile: path.join(dir, "updates.log"), latestUrl: s.base + "latest.json" });
  await u.check();
  assert.deepEqual(u.info(), { version: "0.2.0", notes: ["Updates itself"], ready: false });
  assert.equal(u.isReady(), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".exe") || f.endsWith(".part")), []);
  assert.match(fs.readFileSync(path.join(dir, "updates.log"), "utf8"), /SHA-512/);
  assert.equal(u.install({ reopen: true }), false);
  await s.close();
});

test("too big is cut off; up to date shows nothing; a missing site is only logged", async () => {
  const s = await site({
    "/download/win/latest.json": latest({ size: 100 }),
    "/download/win/Deskwisp-Setup-0.2.0-x64.exe": exe,
  });
  const dir = tmp();
  const log = path.join(dir, "updates.log");
  const u = createUpdater({ currentVersion: "0.1.0", dir, logFile: log, latestUrl: s.base + "latest.json" });
  await u.check();
  assert.equal(u.isReady(), false);
  assert.match(fs.readFileSync(log, "utf8"), /bigger/);
  await s.close();

  const s2 = await site({ "/download/win/latest.json": latest({ version: "0.1.0" }) });
  const u2 = createUpdater({ currentVersion: "0.1.0", dir, logFile: log, latestUrl: s2.base + "latest.json" });
  await u2.check();
  assert.equal(u2.info(), null);
  assert.equal(s2.hits.length, 1);
  await s2.close();

  const u3 = createUpdater({ currentVersion: "0.1.0", dir, logFile: log, latestUrl: s2.base + "latest.json" });
  await u3.check();
  assert.equal(u3.info(), null);
  assert.match(fs.readFileSync(log, "utf8"), /couldn't check/);
});
