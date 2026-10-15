import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

/**
 * Who a Clerk session token belongs to. The approve page (accounts.ts) gets the token from Clerk in
 * the browser (Clerk.session.getToken()) and sends it with the approval; this checks it here, with
 * no Clerk SDK: the token is an RS256 JWT signed with one of the instance's keys (Clerk's Backend API,
 * GET /v1/jwks, with the secret key), and must be current and made for this server's own page (azp).
 * Then the user's email and name come from GET /v1/users/{id}.
 */

export type ClerkPerson = { clerkId: string; email: string | null; name: string | null };
export type Verifier = (sessionToken: string) => Promise<ClerkPerson>;

export class NotSignedIn extends Error {}

const API = "https://api.clerk.com/v1";
/** Clock difference allowed between Clerk and this server. */
const SKEW_S = 10;

const b64url = (s: string) => Buffer.from(s, "base64url");

export function clerkVerifier(opts: { secretKey: string; authorizedParties: string[]; fetchImpl?: typeof fetch }): Verifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.secretKey}` };
  let keys: { at: number; byKid: Map<string, KeyObject> } | null = null;

  async function jwks(force: boolean) {
    if (!force && keys && Date.now() - keys.at < 60 * 60_000) return keys.byKid;
    const res = await fetchImpl(`${API}/jwks`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Clerk's keys: ${res.status}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const byKid = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") byKid.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
    keys = { at: Date.now(), byKid };
    return byKid;
  }

  return async (token) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new NotSignedIn("not a session token");
    let header: { alg?: string; kid?: string };
    let claims: { sub?: string; exp?: number; nbf?: number; azp?: string };
    try {
      header = JSON.parse(b64url(parts[0]).toString("utf8"));
      claims = JSON.parse(b64url(parts[1]).toString("utf8"));
    } catch {
      throw new NotSignedIn("not a session token");
    }
    if (header.alg !== "RS256" || !header.kid) throw new NotSignedIn("not a Clerk session token");
    // A key Clerk rotated in since the last look: ask once more.
    const key = (await jwks(false)).get(header.kid) ?? (await jwks(true)).get(header.kid);
    if (!key) throw new NotSignedIn("signed with a key this instance doesn't have");
    if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]))) throw new NotSignedIn("bad signature");
    const now = Date.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp < now - SKEW_S) throw new NotSignedIn("session token expired");
    if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_S) throw new NotSignedIn("session token not valid yet");
    if (claims.azp && !opts.authorizedParties.includes(claims.azp)) throw new NotSignedIn(`made for another site (${claims.azp})`);
    if (!claims.sub) throw new NotSignedIn("no user in the token");

    const res = await fetchImpl(`${API}/users/${encodeURIComponent(claims.sub)}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Clerk's user ${claims.sub}: ${res.status}`);
    const u = (await res.json()) as {
      id: string;
      first_name?: string | null;
      last_name?: string | null;
      primary_email_address_id?: string | null;
      email_addresses?: { id: string; email_address: string }[];
    };
    const emails = u.email_addresses ?? [];
    const email = (emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0])?.email_address ?? null;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null;
    return { clerkId: u.id, email, name };
  };
}

/** The Frontend API host a publishable key names (pk_test_<base64 of "host$">), where Clerk's browser script is served. */
export function frontendApi(publishableKey: string): string | null {
  const m = /^pk_(test|live)_(.+)$/.exec(publishableKey.trim());
  if (!m) return null;
  const host = Buffer.from(m[2], "base64").toString("utf8").replace(/\$$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}
