/**
 * The computers API against real X displays, with the local provider (no isolation; it runs here).
 * Needs Xvfb, xdotool, ImageMagick, x11vnc and websockify. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

const have = (bin: string) => {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const missing = ["Xvfb", "xdotool", "convert", "x11vnc", "websockify"].filter((b) => !have(b));

const dir = mkdtempSync(join(tmpdir(), "dcloud-test-"));
const cfg = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, DESKWISP_PORT: "8799", DESKWISP_API_KEYS: "k1=alice,k2=bob", DESKWISP_MAX_COMPUTERS: "2" });
const base = `http://127.0.0.1:${cfg.port}/api`;
let app: ReturnType<typeof startServer>;

const call = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = type.includes("json") ? await res.json() : null;
  return { status: res.status, json, bytes: type.startsWith("image/") ? new Uint8Array(await res.arrayBuffer()) : null };
};

before(async () => {
  app = startServer(cfg);
  await new Promise((r) => app.server.once("listening", r));
});
after(async () => {
  for (const n of [99, 100, 101, 102]) for (const pat of [`[X]vfb :${n} `, `[x]11vnc -display :${n} `, `[w]ebsockify ${5981 + n} `]) execSync(`pkill -f '${pat}' || true`, { shell: "/bin/sh" });
  app.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a key that isn't known is turned down", async () => {
  assert.equal((await call("nope", "GET", "/workspaces")).status, 401);
});

test("a computer from start to delete", { skip: missing.length ? `missing ${missing.join(", ")}` : false, timeout: 120_000 }, async () => {
  // The workspace the app makes the first time (lib/server/horafirm.ts deskwispWorkspace).
  const w = await call("k1", "POST", "/workspaces", { name: "deskwisp" });
  assert.equal(w.status, 200);
  assert.deepEqual((await call("k1", "GET", "/workspaces")).json.workspaces.map((x: { name: string }) => x.name), ["deskwisp"]);
  // Bob sees none of Alice's.
  assert.equal((await call("k2", "GET", "/workspaces")).json.workspaces.length, 0);

  const made = await call("k1", "POST", "/computers", { workspace_id: w.json.id, name: "Wispy", template_ref: "system/deskwisp-base@0.1.8" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.id as string;
  assert.equal(made.json.status, "running");
  assert.match(made.json.vnc_password, /^.{8}$/);
  assert.equal((await call("k2", "GET", `/computers/${id}`)).status, 404, "not Bob's");

  const plan = await call("k1", "GET", `/billing/compute-limits?workspace_id=${w.json.id}`);
  assert.equal(plan.json.computers_used, 1);
  assert.equal(plan.json.max_computers, 2);

  // The boot screen, then one more.
  let screens = (await call("k1", "GET", `/computers/${id}/screens`)).json.screens;
  assert.deepEqual(screens.map((s: { id: string }) => s.id), ["default"]);
  const added = await call("k1", "POST", `/computers/${id}/screens`, { width: 1280, height: 960 });
  assert.equal(added.json.id, "screen-100");
  screens = (await call("k1", "GET", `/computers/${id}/screens`)).json.screens;
  assert.deepEqual(screens.map((s: { id: string }) => s.id), ["default", "screen-100"]);

  // Shell, as the app runs it.
  const sh = await call("k1", "POST", `/computers/${id}/bash`, { command: "echo hi && exit 3", timeout: 10 });
  assert.deepEqual(sh.json, { output: "hi\n", exit_code: 3 });

  // Screenshots: JPEG at 0.75 for the views, PNG at full size for the computer tool.
  const jpg = await call("k1", "GET", `/computers/${id}/screenshot?screen=default&response_format=binary&format=jpeg&scale=0.75`);
  assert.equal(jpg.status, 200);
  assert.deepEqual([...jpg.bytes!.slice(0, 2)], [0xff, 0xd8]);
  const png = await call("k1", "GET", `/computers/${id}/screenshot?screen=screen-100&response_format=binary&format=png&scale=1`);
  assert.deepEqual([...png.bytes!.slice(1, 4)], [0x50, 0x4e, 0x47]);

  // Input lands where it's sent.
  assert.equal((await call("k1", "POST", `/computers/${id}/click?screen=default`, { x: 321, y: 123 })).status, 200);
  const where = await call("k1", "POST", `/computers/${id}/bash`, { command: "DISPLAY=:99 xdotool getmouselocation --shell | head -2 | tr '\\n' ' '", timeout: 10 });
  assert.match(where.json.output, /X=321 Y=123/);
  assert.equal((await call("k1", "POST", `/computers/${id}/type?screen=default`, { text: "it's \"quoted\" $HOME" })).status, 200);
  assert.equal((await call("k1", "POST", `/computers/${id}/key?screen=default`, { key: "ctrl+a" })).status, 200);
  assert.equal((await call("k1", "POST", `/computers/${id}/key?screen=default`, { key: "Return; rm -rf /" })).status, 500);

  // The live view: the right token gets a VNC handshake through the proxy, a wrong one is turned away.
  const banner = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/desktops/${id}/ws/websockify?token=${encodeURIComponent(made.json.vnc_password)}`, ["binary"]);
    ws.on("message", (d: Buffer) => (resolve(d.toString("latin1")), ws.close()));
    ws.on("error", reject);
  });
  assert.match(banner, /^RFB 003\.00\d/);
  const refused = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/desktops/${id}/ws/websockify?token=wrong`, ["binary"]);
    ws.on("open", () => resolve(false));
    ws.on("error", () => resolve(true));
  });
  assert.ok(refused);

  // Forks fall back to clones; the plan's limit holds.
  assert.equal((await call("k1", "POST", `/computers/${id}/fork`)).json.code, "NOT_FORKABLE");
  assert.equal((await call("k1", "POST", "/computers", { workspace_id: w.json.id, name: "Two" })).status, 200);
  assert.equal((await call("k1", "POST", "/computers", { workspace_id: w.json.id, name: "Three" })).json.code, "COMPUTER_LIMIT");

  const list = await call("k1", "GET", `/workspaces/${w.json.id}`);
  assert.equal(list.json.desktops.length, 2);
  for (const d of list.json.desktops) assert.equal((await call("k1", "DELETE", `/computers/${d.id}`)).status, 200);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).status, 404);
});
