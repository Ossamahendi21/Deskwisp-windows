/**
 * People (people.ts): inviting someone to watch or use the bots' computers, the plan's seats, accepting
 * an invite as the email invited, the watch list, and taking access away, on the JSON store and, with
 * DESKWISP_TEST_DATABASE_URL, on Postgres. Clerk is stood in for by a verifier that knows three tokens.
 * No computer runs here: the live view's passwords are tested against real x11vnc in computers.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import vm from "node:vm";
import pg from "pg";
import { WebSocket } from "ws";
import { NotSignedIn, type Verifier } from "../src/clerk.ts";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hashKey, JsonStore, type Store } from "../src/store.ts";
import { PgStore } from "../src/store-pg.ts";

const who: Record<string, { clerkId: string; email: string; name: string }> = {
  "tok-ana": { clerkId: "user_ana", email: "ana@example.com", name: "Ana" },
  "tok-bob": { clerkId: "user_bob", email: "bob@example.com", name: "Bob" },
  "tok-cara": { clerkId: "user_cara", email: "cara@example.com", name: "Cara" },
};
const fakeClerk: Verifier = async (token) => {
  const p = who[token];
  if (!p) throw new NotSignedIn("unknown token");
  return p;
};

const PG = process.env.DESKWISP_TEST_DATABASE_URL;
const stores: { name: string; open: (dir: string) => Promise<Store>; skip?: string }[] = [
  { name: "JSON", open: async (dir) => new JsonStore(join(dir, "store.json")) },
  {
    name: "Postgres",
    skip: PG ? undefined : "set DESKWISP_TEST_DATABASE_URL to a throwaway database",
    open: async () => {
      const c = new pg.Client({ connectionString: PG });
      await c.connect();
      await c.query("DROP SCHEMA IF EXISTS deskwisp CASCADE");
      await c.end();
      return PgStore.open(PG!);
    },
  },
];

let port = 8830;
for (const kind of stores) {
  describe(`people on ${kind.name}`, { skip: kind.skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), "dcloud-people-"));
    const cfg = loadConfig({
      DESKWISP_PROVIDER: "local",
      DESKWISP_DATA_DIR: dir,
      DESKWISP_PORT: String(port++),
      DESKWISP_PUBLIC_URL: "https://cloud.example.com",
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("fine-ant-12.clerk.accounts.dev$").toString("base64")}`,
    });
    const origin = `http://127.0.0.1:${cfg.port}`;
    const mail: { to: string; subject: string; text: string }[] = [];
    let app: Awaited<ReturnType<typeof startServer>> | null = null;
    const up = async () => {
      if (app) return app;
      app = await startServer(cfg, {
        store: await kind.open(dir),
        verifier: fakeClerk,
        people: { send: async (to, subject, text) => (mail.push({ to, subject, text }), to !== "nomail@example.com") },
      });
      if (!app.server.listening) await new Promise((r) => app!.server.once("listening", r));
      return app;
    };
    after(async () => {
      if (app) await new Promise((r) => app!.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<{ status: number; json: any; text: string }> => {
      await up();
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: { ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* a page */
      }
      return { status: res.status, json, text };
    };

    let ws = "";
    const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

    test("Free adds nobody; Pro two people, invites counted", async () => {
      const a = await up();
      const ana = await a.store.upsertUser({ clerkId: "user_ana", email: "ana@example.com", name: "Ana" });
      await a.store.addKey(ana.id, hashKey("ana-key"), "test");
      ws = (await call("POST", "/api/workspaces", { bearer: "ana-key", body: { name: "deskwisp" } })).json.id;

      const first = await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" });
      assert.equal(first.status, 200);
      assert.deepEqual(first.json.members, [{ id: ana.id, role: "owner", email: "ana@example.com", alt: "Ana" }]);
      assert.deepEqual(first.json.invites, []);
      assert.equal(first.json.seats.plan, "free_deskwisp");
      assert.equal(first.json.seats.limit, 0);
      assert.equal(first.json.seats.can_add, false);
      assert.equal(first.json.seats.upgrade_tier, "pro_deskwisp");

      const free = await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "bob@example.com", permission: "viewer" } });
      assert.equal(free.status, 402);
      assert.equal(free.json.code, "UPGRADE_REQUIRED");
      assert.equal(free.json.upgradeTier, "pro_deskwisp");

      await a.store.setPlan(ana.id, "pro_deskwisp");
      const bob = await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "Bob@Example.com ", permission: "viewer" } });
      assert.equal(bob.status, 200, JSON.stringify(bob.json));
      assert.equal(bob.json.email_sent, true);
      assert.match(bob.json.accept_url, /^https:\/\/cloud\.example\.com\/accept-invite\?token=[\w-]+&project_id=/);
      assert.equal(mail.at(-1)!.to, "bob@example.com");
      assert.ok(mail.at(-1)!.text.includes(bob.json.accept_url), "the email carries the link");
      const cara = await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "cara@example.com", permission: "admin" } });
      assert.equal(cara.status, 200);

      const full = await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "nomail@example.com", permission: "viewer" } });
      assert.equal(full.status, 402);
      assert.equal(full.json.code, "SEAT_LIMIT");
      assert.equal(full.json.limit, 2);
      assert.equal(full.json.used, 2);
      assert.equal(full.json.upgradeTier, "max_deskwisp");

      // Sending Bob's again is fine when the plan is full: a new link, and the old one stops working.
      const again = await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "bob@example.com", permission: "viewer" } });
      assert.equal(again.status, 200);
      assert.notEqual(tokenOf(again.json.accept_url), tokenOf(bob.json.accept_url));
      const old = await call("POST", "/api/invites/accept", { bearer: "tok-bob", body: { token: tokenOf(bob.json.accept_url) } });
      assert.equal(old.status, 404);

      assert.equal((await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "ana@example.com" } })).json.code, "self");
      assert.equal((await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "not an email" } })).status, 400);

      const list = await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" });
      assert.deepEqual(list.json.invites.map((i: { email: string; role: string }) => [i.email, i.role]).sort(), [
        ["bob@example.com", "member"],
        ["cara@example.com", "admin"],
      ]);
      assert.ok(list.json.invites.every((i: { token?: string }) => typeof i.token === "string"));
      assert.equal(list.json.seats.used, 2);
    });

    test("only the email invited can take an invite, once", async () => {
      const list = await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" });
      const bobToken = list.json.invites.find((i: { email: string }) => i.email === "bob@example.com").token;
      assert.equal((await call("POST", "/api/invites/accept", { body: { token: bobToken } })).status, 401);
      const wrong = await call("POST", "/api/invites/accept", { bearer: "tok-cara", body: { token: bobToken } });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.code, "wrong_email");
      const ok = await call("POST", "/api/invites/accept", { bearer: "tok-bob", body: { token: bobToken } });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.deepEqual(ok.json, { ok: true, owner: "Ana", role: "member" });
      assert.equal((await call("POST", "/api/invites/accept", { bearer: "tok-bob", body: { token: bobToken } })).status, 404);

      const after = await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" });
      const bob = after.json.members.find((m: { email: string }) => m.email === "bob@example.com");
      assert.equal(bob.role, "member");
      assert.equal(bob.alt, "Bob");
      assert.deepEqual(after.json.invites.map((i: { email: string }) => i.email), ["cara@example.com"]);
      const spaces = await call("GET", "/api/workspaces", { bearer: "ana-key" });
      assert.equal(spaces.json.workspaces[0].member_count, 2);
      assert.equal((await call("POST", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "bob@example.com" } })).json.code, "already_in");
    });

    test("the watch list: your own computers, and the ones shared with you", async () => {
      const a = await up();
      const ana = (await a.store.upsertUser({ clerkId: "user_ana", email: "ana@example.com", name: "Ana" })).id;
      const pc = await a.store.addComputer({ owner: ana, workspaceId: ws, name: "Wispy", boxId: "box-x", provider: "local", cpu: 2, ram: 4 });
      assert.match(pc.viewPassword, /^.{8}$/);
      assert.notEqual(pc.viewPassword, pc.vncPassword);
      const mine = await call("GET", "/api/watch", { bearer: "tok-ana" });
      assert.deepEqual(mine.json.computers.map((c: { name: string; owner: string; role: string }) => [c.name, c.owner, c.role]), [["Wispy", "You", "owner"]]);
      assert.equal(JSON.stringify(mine.json).includes(pc.vncPassword), false, "no password in the list");
      const bobs = await call("GET", "/api/watch", { bearer: "tok-bob" });
      assert.deepEqual(bobs.json.computers.map((c: { name: string; owner: string; role: string }) => [c.name, c.owner, c.role]), [["Wispy", "Ana", "member"]]);
      assert.deepEqual((await call("GET", "/api/watch", { bearer: "tok-cara" })).json.computers, [], "Cara hasn't accepted");
      assert.equal((await call("POST", "/api/watch/open", { bearer: "tok-cara", body: { computerId: pc.id } })).status, 404);
      assert.equal((await call("GET", "/api/watch")).status, 401);

      // A live view needs a ticket this server signed.
      const refused = await new Promise<boolean>((resolve) => {
        const s = new WebSocket(`ws://127.0.0.1:${cfg.port}/desktops/${pc.id}/ws/websockify?ticket=abc.def&screen=default`, ["binary"]);
        s.on("open", () => resolve(false));
        s.on("error", () => resolve(true));
      });
      assert.ok(refused);
    });

    test("access changed and taken away; invites cancelled", async () => {
      const list = await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" });
      const bob = list.json.members.find((m: { email: string }) => m.email === "bob@example.com");
      assert.equal((await call("PATCH", `/api/workspaces/${ws}/members`, { bearer: "ana-key", body: { memberId: bob.id, role: "admin" } })).status, 200);
      assert.equal((await call("GET", "/api/watch", { bearer: "tok-bob" })).json.computers[0].role, "admin");
      // From Full access back out: the computers get new passwords.
      const a = await up();
      const before = { ...(await a.store.computers(list.json.members[0].id))[0] };
      assert.equal((await call("DELETE", `/api/workspaces/${ws}/members`, { bearer: "ana-key", body: { memberId: bob.id } })).status, 200);
      const now = (await a.store.computers(list.json.members[0].id))[0];
      assert.notEqual(now.vncPassword, before.vncPassword);
      assert.notEqual(now.viewPassword, before.viewPassword);
      assert.deepEqual((await call("GET", "/api/watch", { bearer: "tok-bob" })).json.computers, []);
      assert.equal((await call("DELETE", `/api/workspaces/${ws}/members`, { bearer: "ana-key", body: { memberId: bob.id } })).status, 404);

      assert.equal((await call("DELETE", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "cara@example.com" } })).status, 200);
      assert.equal((await call("DELETE", `/api/workspaces/${ws}/invite`, { bearer: "ana-key", body: { email: "cara@example.com" } })).status, 404);
      assert.equal((await call("GET", `/api/workspaces/${ws}/members`, { bearer: "ana-key" })).json.seats.used, 0);
      // Someone else's workspace is nobody's business.
      const a2 = await a.store.upsertUser({ clerkId: "user_bob", email: "bob@example.com", name: "Bob" });
      await a.store.addKey(a2.id, hashKey("bob-key"), "test");
      assert.equal((await call("GET", `/api/workspaces/${ws}/members`, { bearer: "bob-key" })).status, 404);
    });

    test("the accept and watch pages, and noVNC's files", async () => {
      for (const path of ["/accept-invite?token=abc&project_id=x", "/watch"]) {
        const page = await call("GET", path);
        assert.equal(page.status, 200);
        assert.match(page.text, /clerk-js@5\/dist\/clerk\.browser\.js/);
        const scripts = [...page.text.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1].replace(/^\s*import .*$/m, ""));
        assert.ok(scripts.length > 0, path);
        for (const js of scripts) assert.doesNotThrow(() => new vm.Script(js), `${path} has a script that doesn't parse`);
      }
      const rfb = await call("GET", "/novnc/core/rfb.js");
      assert.equal(rfb.status, 200);
      assert.match(rfb.text, /export default class RFB/);
      for (const bad of ["/novnc/package.json", "/novnc/core/../package.json", "/novnc/core/..%2F..%2Fpackage.json", "/novnc/docs/API.md"])
        assert.equal((await call("GET", bad)).status, 404, bad);
    });
  });
}
