/**
 * Signing in with an email code in the app (src/email-sign-in.ts), against a stand-in for Clerk's
 * Frontend API: an account that exists signs in, a new email gets an account, a wrong code is said
 * so, and the app ends up with its key. Run: node --test dcloud/test/
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { EmailSignIn, EmailSignInError } from "../src/email-sign-in.ts";
import { startServer } from "../src/server.ts";
import { JsonStore } from "../src/store.ts";

/** Clerk's Frontend API, as much of it as the flow uses. Codes are always 424242. */
function fakeClerk() {
  const seen: { method: string; path: string; native: boolean; auth: string | null; form: Record<string, string> }[] = [];
  const users: Record<string, string> = { "ana@example.com": "user_ana" };
  const attempts = new Map<string, { email: string; kind: "in" | "up" }>();
  let n = 0;
  const json = (status: number, body: unknown, token = "client_tok") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", Authorization: token } });
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.host, "fine-ant-12.clerk.accounts.dev");
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const path = url.pathname.replace(/^\/v1/, "");
    seen.push({ method: init?.method ?? "GET", path, native: url.searchParams.get("_is_native") === "1", auth: new Headers(init?.headers).get("authorization"), form });
    if (path === "/client") return json(200, { response: null });
    if (path === "/client/sign_ins") {
      const id = users[form.identifier];
      if (!id) return json(422, { errors: [{ code: "form_identifier_not_found", message: "Couldn't find your account." }] });
      const sid = `sia_${++n}`;
      attempts.set(sid, { email: form.identifier, kind: "in" });
      return json(200, { response: { id: sid, status: "needs_first_factor", supported_first_factors: [{ strategy: "email_code", email_address_id: "idn_1" }] } });
    }
    if (path === "/client/sign_ups") {
      const sid = `sua_${++n}`;
      attempts.set(sid, { email: form.email_address, kind: "up" });
      return json(200, { response: { id: sid, status: "missing_requirements", unverified_fields: ["email_address"] } });
    }
    const m = /^\/client\/(sign_ins|sign_ups)\/([^/]+)\/(\w+)$/.exec(path);
    if (m) {
      const a = attempts.get(m[2]);
      if (!a) return json(404, { errors: [{ code: "resource_not_found" }] });
      if (m[3] === "prepare_first_factor" || m[3] === "prepare_verification") return json(200, { response: { id: m[2] } });
      if (form.code !== "424242") return json(422, { errors: [{ code: "form_code_incorrect", message: "Incorrect code" }] });
      if (a.kind === "in") return json(200, { response: { status: "complete", created_session_id: "sess_1" }, client: { sessions: [{ id: "sess_1", user: { id: users[a.email] } }] } });
      users[a.email] = "user_new";
      return json(200, { response: { status: "complete", created_user_id: "user_new", created_session_id: "sess_2" } });
    }
    return json(404, { errors: [{ code: "resource_not_found" }] });
  }) as typeof fetch;
  return { fetch: f, seen };
}

test("an account that exists signs in with the code Clerk emails", async () => {
  const clerk = fakeClerk();
  const e = new EmailSignIn({ host: "fine-ant-12.clerk.accounts.dev", fetchImpl: clerk.fetch });
  const s = await e.start(" Ana@Example.com ", "Ana's PC");
  assert.equal(s.mode, "sign_in");
  // Every call is a native client's, with the token Clerk handed back after the first.
  assert.ok(clerk.seen.every((c) => c.native));
  assert.ok(clerk.seen.slice(1).every((c) => c.auth === "client_tok"));
  assert.deepEqual(clerk.seen.find((c) => c.path.endsWith("/prepare_first_factor"))?.form, { strategy: "email_code", email_address_id: "idn_1" });

  await assert.rejects(e.verify(s.flow, "111111"), (err: EmailSignInError) => err.code === "form_code_incorrect" && err.status === 400);
  const done = await e.verify(s.flow, "424 242");
  assert.deepEqual(done, { clerkId: "user_ana", sessionId: "sess_1", email: "ana@example.com", hostname: "Ana's PC" });
  // A flow is used once.
  await assert.rejects(e.verify(s.flow, "424242"), (err: EmailSignInError) => err.code === "expired");
});

test("a new email gets an account, verified by the same kind of code", async () => {
  const clerk = fakeClerk();
  const e = new EmailSignIn({ host: "fine-ant-12.clerk.accounts.dev", fetchImpl: clerk.fetch });
  const s = await e.start("new@example.com", "PC");
  assert.equal(s.mode, "sign_up");
  assert.deepEqual(clerk.seen.find((c) => c.path.endsWith("/prepare_verification"))?.form, { strategy: "email_code" });
  assert.equal((await e.verify(s.flow, "424242")).clerkId, "user_new");
});

test("what isn't an email, and too many wrong codes, are turned down", async () => {
  const e = new EmailSignIn({ host: "fine-ant-12.clerk.accounts.dev", fetchImpl: fakeClerk().fetch });
  await assert.rejects(e.start("not-an-email", "PC"), (err: EmailSignInError) => err.code === "bad_email");
  const s = await e.start("ana@example.com", "PC");
  for (let i = 0; i < 5; i++) await assert.rejects(e.verify(s.flow, "000000"));
  await assert.rejects(e.verify(s.flow, "424242"), (err: EmailSignInError) => err.code === "too_many_tries");
});

test("through the server: the app gets its key, and Clerk's own session is ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcloud-email-"));
  const cfg = loadConfig({ DESKWISP_PROVIDER: "local", DESKWISP_DATA_DIR: dir, DESKWISP_PORT: "8820" });
  const ended: string[] = [];
  const app = await startServer(cfg, {
    store: new JsonStore(join(dir, "store.json")),
    verifier: null,
    accounts: {
      email: new EmailSignIn({ host: "fine-ant-12.clerk.accounts.dev", fetchImpl: fakeClerk().fetch }),
      person: async (clerkId) => ({ clerkId, email: "ana@example.com", name: "Ana" }),
      endSession: async (id) => void ended.push(id),
    },
  });
  if (!app.server.listening) await new Promise((r) => app.server.once("listening", r));
  after(async () => {
    await new Promise((r) => app.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const s = await post("/api/auth/email/start", { email: "ana@example.com", hostname: "Ana's PC" });
  assert.equal(s.status, 200);
  const bad = await post("/api/auth/email/verify", { flow: s.json.flow, code: "123456" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "form_code_incorrect");
  const ok = await post("/api/auth/email/verify", { flow: s.json.flow, code: "424242" });
  assert.equal(ok.status, 200);
  assert.match(ok.json.api_key as string, /^dw_/);
  assert.deepEqual(ended, ["sess_1"]);
  const me = await fetch(`http://127.0.0.1:${cfg.port}/api/user/profile`, { headers: { Authorization: `Bearer ${ok.json.api_key}` } });
  assert.deepEqual(await me.json(), { id: (ok.json.user as { id: string }).id, email: "ana@example.com", full_name: "Ana" });
});
