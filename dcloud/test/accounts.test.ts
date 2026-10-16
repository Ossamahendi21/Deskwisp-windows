/**
 * Signing in from the app (the device-code flow the app already speaks) and whose key is whose, on the
 * JSON store and, when DESKWISP_TEST_DATABASE_URL names a throwaway Postgres, on Postgres too. Clerk is
 * stood in for by a verifier that knows two tokens. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import vm from "node:vm";
import pg from "pg";
import { NotSignedIn, type Verifier } from "../src/clerk.ts";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { JsonStore, type Store } from "../src/store.ts";
import { PgStore } from "../src/store-pg.ts";

const people: Record<string, { clerkId: string; email: string; name: string }> = {
  "tok-ana": { clerkId: "user_ana", email: "ana@example.com", name: "Ana" },
  "tok-bob": { clerkId: "user_bob", email: "bob@example.com", name: "Bob" },
};
const fakeClerk: Verifier = async (token) => {
  const p = people[token];
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
      // A clean schema each run: the migrations make it again.
      const c = new pg.Client({ connectionString: PG });
      await c.connect();
      await c.query("DROP SCHEMA IF EXISTS deskwisp CASCADE");
      await c.end();
      return PgStore.open(PG!);
    },
  },
];

let port = 8810;
for (const kind of stores) {
  describe(`accounts on ${kind.name}`, { skip: kind.skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), "dcloud-accounts-"));
    const cfg = loadConfig({
      DESKWISP_PROVIDER: "local",
      DESKWISP_DATA_DIR: dir,
      DESKWISP_PORT: String(port++),
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("fine-ant-12.clerk.accounts.dev$").toString("base64")}`,
    });
    const origin = `http://127.0.0.1:${cfg.port}`;
    let app: Awaited<ReturnType<typeof startServer>> | null = null;
    const up = async () => {
      if (app) return app;
      app = await startServer(cfg, { store: await kind.open(dir), verifier: fakeClerk });
      if (!app.server.listening) await new Promise((r) => app!.server.once("listening", r));
      return app;
    };
    after(async () => {
      if (app) await new Promise((r) => app!.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });

    const call = async (method: string, path: string, opts: { body?: unknown; bearer?: string } = {}) => {
      await up();
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: { ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* a page */
      }
      return { status: res.status, json: json ?? {}, text };
    };

    /** The app's side of a sign-in, approved in the browser by `token`'s person. */
    const signIn = async (token: string, hostname = "Ana's PC") => {
      const start = await call("POST", "/api/cli/auth/start", { body: { client: "Deskwisp", hostname } });
      assert.equal(start.status, 200);
      const { device_code, user_code } = start.json as { device_code: string; user_code: string };
      assert.equal((await call("POST", "/api/cli/auth/approve", { bearer: token, body: { user_code, approve: true } })).status, 200);
      const done = await call("POST", "/api/cli/auth/poll", { body: { device_code } });
      assert.equal(done.json.status, "approved");
      return done.json.api_key as string;
    };

    test("a sign-in from start to key", async () => {
      const start = await call("POST", "/api/cli/auth/start", { body: { client: "Deskwisp", hostname: "Ana's PC" } });
      assert.equal(start.status, 200);
      const s = start.json as { device_code: string; user_code: string; verification_uri_complete: string; interval_seconds: number };
      assert.match(s.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal(s.verification_uri_complete, `http://localhost:${cfg.port}/cli/approve?code=${s.user_code}`);
      assert.equal(s.interval_seconds, 2);

      assert.equal((await call("POST", "/api/cli/auth/poll", { body: { device_code: s.device_code } })).json.status, "pending");
      assert.deepEqual((await call("GET", `/api/cli/auth/info?code=${s.user_code}`)).json, { state: "pending", hostname: "Ana's PC" });

      // Approving takes a Clerk session.
      assert.equal((await call("POST", "/api/cli/auth/approve", { body: { user_code: s.user_code, approve: true } })).status, 401);
      assert.equal((await call("POST", "/api/cli/auth/approve", { bearer: "tok-nobody", body: { user_code: s.user_code, approve: true } })).status, 401);
      const ok = await call("POST", "/api/cli/auth/approve", { bearer: "tok-ana", body: { user_code: s.user_code, approve: true } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.email, "ana@example.com");
      // Once.
      assert.equal((await call("POST", "/api/cli/auth/approve", { bearer: "tok-bob", body: { user_code: s.user_code, approve: true } })).status, 409);

      const done = await call("POST", "/api/cli/auth/poll", { body: { device_code: s.device_code } });
      assert.equal(done.json.status, "approved");
      const key = done.json.api_key as string;
      assert.match(key, /^dw_[\w-]{43}$/);
      assert.equal((done.json.user as { email: string }).email, "ana@example.com");
      // The key is handed over once; the code is gone with it.
      assert.equal((await call("POST", "/api/cli/auth/poll", { body: { device_code: s.device_code } })).json.status, "expired");
      assert.equal((await call("GET", `/api/cli/auth/info?code=${s.user_code}`)).json.state, "unknown");

      // The key is the app's from now on, as Horafirm's was.
      const me = await call("GET", "/api/user/profile", { bearer: key });
      assert.equal(me.status, 200);
      assert.equal(me.json.email, "ana@example.com");
      assert.equal(me.json.full_name, "Ana");
      assert.equal((await call("GET", "/api/user/profile", { bearer: `${key}x` })).status, 401);
    });

    test("each user sees only their own workspaces, and signing in again is the same user", async () => {
      const ana = await signIn("tok-ana");
      const again = await signIn("tok-ana", "Ana's laptop");
      const bob = await signIn("tok-bob", "Bob's PC");
      const w = await call("POST", "/api/workspaces", { bearer: ana, body: { name: "deskwisp" } });
      assert.equal(w.status, 200);
      assert.equal((await call("POST", "/api/workspaces", { bearer: again, body: { name: "DESKWISP " } })).status, 409, "the same name twice");
      assert.deepEqual(((await call("GET", "/api/workspaces", { bearer: again })).json.workspaces as { id: string }[]).map((x) => x.id), [w.json.id]);
      assert.equal(((await call("GET", "/api/workspaces", { bearer: bob })).json.workspaces as unknown[]).length, 0);
      assert.equal((await call("GET", `/api/workspaces/${w.json.id}`, { bearer: bob })).status, 404);
      assert.equal((await call("GET", "/api/computers/not-a-uuid", { bearer: bob })).status, 404);
    });

    test("a sign-in turned down, and a code that isn't one", async () => {
      const start = await call("POST", "/api/cli/auth/start", { body: { hostname: "Someone's PC" } });
      const { device_code, user_code } = start.json as { device_code: string; user_code: string };
      assert.equal((await call("POST", "/api/cli/auth/approve", { bearer: "tok-bob", body: { user_code, approve: false } })).status, 200);
      assert.equal((await call("POST", "/api/cli/auth/poll", { body: { device_code } })).json.status, "denied");
      assert.equal((await call("POST", "/api/cli/auth/poll", { body: { device_code: "made-up" } })).json.status, "expired");
      assert.equal((await call("POST", "/api/cli/auth/approve", { bearer: "tok-bob", body: { user_code: "AAAA-BBBB", approve: true } })).status, 410);
    });

    test("the pages' own scripts are valid JavaScript", async () => {
      // A script that doesn't parse leaves a page stuck on its first words, with nothing said.
      for (const path of ["/cli/approve?code=ABCD-EFGH", "/cli/sso-callback?next=%2Fcli%2Fapprove%3Fcode%3DABCD-EFGH"]) {
        const page = await call("GET", path);
        const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        assert.ok(scripts.length > 0, path);
        for (const js of scripts) assert.doesNotThrow(() => new vm.Script(js), `${path} has a script that doesn't parse`);
      }
    });

    test("the approve page loads Clerk from the instance's own host", async () => {
      const page = await call("GET", "/cli/approve?code=ABCD-EFGH");
      assert.equal(page.status, 200);
      assert.match(page.text, /src="https:\/\/fine-ant-12\.clerk\.accounts\.dev\/npm\/@clerk\/clerk-js@5\/dist\/clerk\.browser\.js"/);
      assert.match(page.text, /data-clerk-publishable-key="pk_test_/);
      assert.match(page.text, /<title>Sign in to Deskwisp<\/title>/);
    });
  });
}
