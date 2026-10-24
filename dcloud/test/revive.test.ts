/**
 * A computer whose box the provider lost (an E2B sandbox past its longest life) gets a new one under the
 * same computer (src/computers.ts revive), instead of answering 404 for good. Real X displays, with the
 * local provider. Needs Xvfb, xdotool, ImageMagick, x11vnc and websockify. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { LocalProvider } from "../src/providers/local.ts";
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

const dir = mkdtempSync(join(tmpdir(), "dcloud-revive-"));
const cfg = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, DESKWISP_PORT: "8797", DESKWISP_API_KEYS: "k1=alice", DESKWISP_MAX_COMPUTERS: "2" });
const base = `http://127.0.0.1:${cfg.port}/api`;
const provider = new LocalProvider(join(dir, "boxes"));
let app: Awaited<ReturnType<typeof startServer>>;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: "Bearer k1", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : null;
  return { status: res.status, json };
};

before(async () => {
  app = await startServer(cfg, { provider });
  await new Promise((r) => app.server.once("listening", r));
});
after(async () => {
  for (const n of [99, 100, 101, 102]) for (const pat of [`[X]vfb :${n} `, `[x]11vnc -display :${n} `, `[w]ebsockify ${5981 + n} `]) execSync(`pkill -f '${pat}' || true`, { shell: "/bin/sh" });
  app.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a computer whose box is gone gets a new one, the same computer to the app", { skip: missing.length ? `missing ${missing.join(", ")}` : false, timeout: 180_000 }, async () => {
  const w = await call("POST", "/workspaces", { name: "deskwisp" });
  const made = await call("POST", "/computers", { workspace_id: w.json.id, name: "Wispy" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.id as string;
  // A copy: the JSON store hands back the record itself, which revive updates.
  const before = { ...(await app.store.computer("alice", id))! };

  // The provider loses the box (E2B ends a sandbox after its longest life).
  await provider.kill(before.boxId);
  for (const n of [99, 100, 101, 102]) for (const pat of [`[X]vfb :${n} `, `[x]11vnc -display :${n} `, `[w]ebsockify ${5981 + n} `]) execSync(`pkill -f '${pat}' || true`, { shell: "/bin/sh" });
  await new Promise((r) => setTimeout(r, 31_000)); // past the 30 seconds a box known open isn't asked about again

  const again = await call("GET", `/computers/${id}`);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.id, id, "the same computer");
  const after = (await app.store.computer("alice", id))!;
  assert.notEqual(after.boxId, before.boxId, "on a new box");
  assert.equal(after.vncPassword, before.vncPassword, "with its passwords");
  assert.equal(await provider.state(after.boxId), "running");
  // And it works: a command runs on it.
  const ran = await call("POST", `/computers/${id}/bash`, { command: "echo hi" });
  assert.equal(ran.status, 200, JSON.stringify(ran.json));
  assert.match(ran.json.output, /hi/);
  // One computer still, the plan's.
  assert.equal((await call("GET", `/billing/compute-limits?workspace_id=${w.json.id}`)).json.deskwisp_free_computer_id, id);
});
