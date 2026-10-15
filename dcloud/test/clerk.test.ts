/** The Clerk session-token check (src/clerk.ts), against a stand-in for Clerk's Backend API. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { clerkVerifier, frontendApi, NotSignedIn } from "../src/clerk.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ins_1", alg: "RS256", use: "sig" };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "ins_1") {
  const head = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

const calls: string[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push(String(url));
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_test_x");
  if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
  if (String(url).endsWith("/users/user_ana"))
    return Response.json({
      id: "user_ana",
      first_name: "Ana",
      last_name: "B",
      primary_email_address_id: "e2",
      email_addresses: [
        { id: "e1", email_address: "old@example.com" },
        { id: "e2", email_address: "ana@example.com" },
      ],
    });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const verify = clerkVerifier({ secretKey: "sk_test_x", authorizedParties: ["http://localhost:8791"], fetchImpl: fakeFetch });
const now = () => Math.floor(Date.now() / 1000);

test("a current token for this page names its user", async () => {
  const p = await verify(token({ sub: "user_ana", exp: now() + 60, nbf: now() - 5, azp: "http://localhost:8791" }));
  assert.deepEqual(p, { clerkId: "user_ana", email: "ana@example.com", name: "Ana B" });
  // Clerk's keys are asked for once, then kept.
  await verify(token({ sub: "user_ana", exp: now() + 60 }));
  assert.equal(calls.filter((u) => u.endsWith("/jwks")).length, 1);
});

test("a token that's expired, for another site, signed by someone else or not a token is turned down", async () => {
  await assert.rejects(verify(token({ sub: "user_ana", exp: now() - 60 })), NotSignedIn);
  await assert.rejects(verify(token({ sub: "user_ana", exp: now() + 60, azp: "https://evil.example" })), NotSignedIn);
  await assert.rejects(verify(token({ sub: "user_ana", exp: now() + 60 }, other.privateKey)), NotSignedIn);
  await assert.rejects(verify(token({ sub: "user_ana", exp: now() + 60 }, privateKey, "ins_unknown")), NotSignedIn);
  await assert.rejects(verify("nope"), NotSignedIn);
});

test("the Frontend API host comes from the publishable key", () => {
  assert.equal(frontendApi(`pk_test_${Buffer.from("fine-ant-12.clerk.accounts.dev$").toString("base64")}`), "fine-ant-12.clerk.accounts.dev");
  assert.equal(frontendApi("sk_test_nope"), null);
});
