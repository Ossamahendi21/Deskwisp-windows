/**
 * The computers API against real X displays, with the local provider (no isolation; it runs here).
 * Needs Xvfb, xdotool, ImageMagick, x11vnc and websockify. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hashKey } from "../src/store.ts";

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
let app: Awaited<ReturnType<typeof startServer>>;

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
  app = await startServer(cfg);
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
  assert.equal(plan.json.max_computers, 1);
  assert.equal(plan.json.max_screens, 4);

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

  // Asleep: put to sleep by its user, then looks (status, screens, screenshots) leave it asleep, and a use wakes it.
  assert.equal((await call("k1", "POST", `/computers/${id}/suspend`)).status, 200);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).json.status, "suspended");
  const look = await call("k1", "GET", `/computers/${id}/screenshot?screen=default&format=jpeg&scale=0.5`);
  assert.equal(look.status, 409);
  assert.equal(look.json.code, "computer_asleep");
  assert.equal((await call("k1", "GET", `/computers/${id}/screens`)).json.code, "computer_asleep");
  assert.equal((await call("k1", "GET", `/computers/${id}`)).json.status, "suspended", "still asleep after the looks");
  assert.equal((await call("k1", "POST", `/computers/${id}/bash`, { command: "true", timeout: 10 })).status, 200);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).json.status, "running");
  // Nobody uses it for the idle time: it goes to sleep on its own.
  await app.computers.sweep(Date.now() + cfg.idleMs + 1000);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).json.status, "suspended");
  assert.equal((await call("k1", "POST", `/computers/${id}/resume`)).status, 200);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).json.status, "running");

  // Forks fall back to clones; every plan has one computer.
  assert.equal((await call("k1", "POST", `/computers/${id}/fork`)).json.code, "NOT_FORKABLE");
  assert.equal((await call("k1", "POST", "/computers", { workspace_id: w.json.id, name: "Two" })).json.code, "COMPUTER_LIMIT");

  const list = await call("k1", "GET", `/workspaces/${w.json.id}`);
  assert.equal(list.json.desktops.length, 1);
  for (const d of list.json.desktops) assert.equal((await call("k1", "DELETE", `/computers/${d.id}`)).status, 200);
  assert.equal((await call("k1", "GET", `/computers/${id}`)).status, 404);
});

test("screens by plan: Free has the one, Max four", { skip: missing.length ? `missing ${missing.join(", ")}` : false, timeout: 120_000 }, async () => {
  // A signed-in user on Free (made here as a sign-in would make them).
  const u = await app.store.upsertUser({ clerkId: "user_free", email: "free@example.com", name: null });
  await app.store.addKey(u.id, hashKey("free-key"), "test");
  const sub = await call("free-key", "GET", "/user/subscription");
  assert.deepEqual(sub.json, { tier: "free_deskwisp", name: "Free", planLimits: { maxDesktops: 1, maxScreens: 1 } });
  const w = await call("free-key", "POST", "/workspaces", { name: "deskwisp" });
  const made = await call("free-key", "POST", "/computers", { workspace_id: w.json.id, name: "Wispy" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const more = await call("free-key", "POST", `/computers/${made.json.id}/screens`, { width: 1280, height: 960 });
  assert.equal(more.status, 403);
  assert.equal(more.json.code, "SCREEN_LIMIT");
  // On Max, the same computer opens more.
  await app.store.setPlan(u.id, "max_deskwisp");
  assert.equal((await call("free-key", "GET", "/user/subscription")).json.planLimits.maxScreens, 4);
  assert.equal((await call("free-key", "POST", `/computers/${made.json.id}/screens`, { width: 1280, height: 960 })).status, 200);
  assert.equal((await call("free-key", "DELETE", `/computers/${made.json.id}`)).status, 200);
});

/** noVNC's DES (VNC's own variant), since Node's OpenSSL has none. */
const des = async (password: string, challenge: Buffer) => {
  const { DESECBCipher } = (await import(new URL("../../node_modules/@novnc/novnc/core/crypto/des.js", import.meta.url).href)) as {
    DESECBCipher: { importKey(key: number[]): { encrypt(alg: unknown, data: Uint8Array): Uint8Array } };
  };
  const key = [...password.padEnd(8, "\0").slice(0, 8)].map((c) => c.charCodeAt(0));
  return Buffer.from(DESECBCipher.importKey(key).encrypt(null, new Uint8Array(challenge)));
};

/** Signs in to a screen's VNC server with a password and moves the pointer there: "in", or "refused". */
async function vncPointer(port: number, password: string, x: number, y: number): Promise<"in" | "refused"> {
  const sock = connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  sock.on("data", (d: Buffer) => ((buf = Buffer.concat([buf, d])), wake?.()));
  sock.on("error", () => wake?.());
  const need = async (n: number) => {
    while (buf.length < n) {
      if (sock.destroyed) throw new Error("closed");
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 2000)));
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  try {
    await need(12);
    sock.write("RFB 003.008\n");
    const types = [...(await need((await need(1))[0]))];
    assert.ok(types.includes(2), `VNC auth offered (${types})`);
    sock.write(Buffer.from([2]));
    sock.write(await des(password, Buffer.from(await need(16))));
    if ((await need(4)).readUInt32BE(0) !== 0) return "refused";
    sock.write(Buffer.from([1]));
    const init = await need(24);
    await need(init.readUInt32BE(20));
    sock.write(Buffer.from([5, 0, x >> 8, x & 255, y >> 8, y & 255]));
    await new Promise((r) => setTimeout(r, 400));
    return "in";
  } finally {
    sock.destroy();
  }
}

test("passwords: the full one acts, the watch-only one only watches, and new ones lock the old out", { skip: missing.length ? `missing ${missing.join(", ")}` : false, timeout: 120_000 }, async () => {
  const w = (await call("k1", "GET", "/workspaces")).json.workspaces[0] ?? (await call("k1", "POST", "/workspaces", { name: "deskwisp" })).json;
  const made = await call("k1", "POST", "/computers", { workspace_id: w.id, name: "Watched" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const c = (await app.store.anyComputer(made.json.id))!;
  assert.match(c.viewPassword, /^.{8}$/);
  const mouse = async () => (await call("k1", "POST", `/computers/${c.id}/bash`, { command: "DISPLAY=:99 xdotool getmouselocation --shell | head -2 | tr '\\n' ' '", timeout: 10 })).json.output as string;

  assert.equal(await vncPointer(5999, c.viewPassword, 111, 77), "in");
  assert.doesNotMatch(await mouse(), /X=111 Y=77/, "watch-only moved the pointer");
  assert.equal(await vncPointer(5999, c.vncPassword, 222, 88), "in");
  assert.match(await mouse(), /X=222 Y=88/);
  assert.equal(await vncPointer(5999, "wrong123", 1, 1), "refused");

  // Someone with Full access left: new passwords, and the old ones are refused.
  const old = { ...c };
  await app.computers.repassword(c);
  const now = (await app.store.anyComputer(c.id))!;
  assert.notEqual(now.vncPassword, old.vncPassword);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await vncPointer(5999, old.vncPassword, 5, 5), "refused");
  assert.equal(await vncPointer(5999, old.viewPassword, 5, 5), "refused");
  assert.equal(await vncPointer(5999, now.vncPassword, 333, 99), "in");
  assert.match(await mouse(), /X=333 Y=99/);
  assert.equal((await call("k1", "GET", `/computers/${c.id}`)).json.vnc_password, now.vncPassword, "the app reads the new one");
  assert.equal((await call("k1", "DELETE", `/computers/${c.id}`)).status, 200);
});
