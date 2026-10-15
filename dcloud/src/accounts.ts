import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./computers.ts";
import type { Config } from "./config.ts";
import { frontendApi, NotSignedIn, type Verifier } from "./clerk.ts";
import { approvePage } from "./pages.ts";
import { hashKey, newAppKey, type Store } from "./store.ts";

/**
 * Accounts: signing in from the app, and whose key is whose.
 *
 * The app signs in the way it did with Horafirm (lib/server/horafirm-sign-in.ts), a device-code flow, so it
 * needs no new code for it: it asks for a code (POST /api/cli/auth/start), opens /cli/approve?code=…
 * in the browser, where the user signs in with Clerk (Google or email) and approves this PC, and
 * polls (POST /api/cli/auth/poll) until a key comes back. That key is the app's from then on
 * (Authorization: Bearer), for the computers and everything else; only its hash is kept.
 */

const CODE_TTL_S = 10 * 60;
const POLL_INTERVAL_S = 2;
/** No 0/O, 1/I/L: a code people compare by eye. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const userCode = () => {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};

/** A few calls a minute per address for the doors anyone can knock on. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  ok(who: string) {
    const now = Date.now();
    const recent = (this.hits.get(who) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.hits.set(who, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return recent.length <= this.perMinute;
  }
}

const addressOf = (req: IncomingMessage) => req.socket.remoteAddress ?? "?";

export class Accounts {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly verify: Verifier | null;
  /** Keys checked lately: their owner, for a minute, so each screenshot doesn't ask the database. */
  private readonly seen = new Map<string, { owner: string | null; at: number }>();
  private readonly starts = new Limiter(10);
  private readonly approvals = new Limiter(30);

  constructor(cfg: Config, store: Store, verify: Verifier | null) {
    this.cfg = cfg;
    this.store = store;
    this.verify = verify;
  }

  /** Whose request this is: a key from DESKWISP_API_KEYS (development), or an app's key from a sign-in. */
  async ownerOf(req: IncomingMessage): Promise<string | null> {
    const key = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1].trim();
    if (!key) return null;
    const fixed = this.cfg.apiKeys.get(key);
    if (fixed) return fixed;
    const hash = hashKey(key);
    const kept = this.seen.get(hash);
    if (kept && Date.now() - kept.at < 60_000) return kept.owner;
    const owner = await this.store.ownerOfKey(hash);
    if (this.seen.size > 50_000) this.seen.clear();
    this.seen.set(hash, { owner, at: Date.now() });
    return owner;
  }

  /** The pages and calls that come before a key: answers true when it was one of them. */
  async public(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<unknown>, send: (status: number, body: unknown) => void): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path === "/cli/approve" && method === "GET") {
      const pk = this.cfg.clerkPublishableKey;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      });
      res.end(approvePage({ publishableKey: pk ?? null, frontendApi: pk ? frontendApi(pk) : null }));
      return true;
    }

    if (path === "/api/cli/auth/start" && method === "POST") {
      if (!this.verify) throw new HttpError(503, "Sign-in isn't set up on this server (CLERK_SECRET_KEY)", "sign_in_off");
      if (!this.starts.ok(addressOf(req))) throw new HttpError(429, "Too many sign-ins. Wait a minute.", "rate_limited");
      const body = (await readBody()) as { hostname?: unknown };
      await this.store.sweepDevices(Date.now());
      const deviceCode = randomBytes(32).toString("base64url");
      const code = userCode();
      await this.store.addDeviceCode({
        id: randomUUID(),
        deviceHash: hashKey(deviceCode),
        userCode: code,
        hostname: String(body?.hostname ?? "").slice(0, 80),
        status: "pending",
        userId: null,
        expiresAt: Date.now() + CODE_TTL_S * 1000,
        createdAt: Date.now(),
      });
      send(200, {
        device_code: deviceCode,
        user_code: code,
        verification_uri_complete: `${this.cfg.publicUrl}/cli/approve?code=${encodeURIComponent(code)}`,
        expires_in_seconds: CODE_TTL_S,
        interval_seconds: POLL_INTERVAL_S,
      });
      return true;
    }

    if (path === "/api/cli/auth/poll" && method === "POST") {
      const body = (await readBody()) as { device_code?: unknown };
      const d = typeof body?.device_code === "string" ? await this.store.deviceByHash(hashKey(body.device_code)) : null;
      if (!d || d.expiresAt <= Date.now()) {
        send(200, { status: "expired" });
        return true;
      }
      if (d.status === "pending") {
        send(200, { status: "pending" });
        return true;
      }
      if (d.status === "denied") {
        send(200, { status: "denied" });
        return true;
      }
      // Approved: the key is made now and handed over once; the code goes with it.
      const userId = await this.store.takeApproved(d.id);
      const user = userId ? await this.store.user(userId) : null;
      if (!user) {
        send(200, { status: "expired" });
        return true;
      }
      const key = newAppKey();
      await this.store.addKey(user.id, hashKey(key), `Deskwisp on ${d.hostname || "a PC"}`);
      send(200, { status: "approved", api_key: key, user: { id: user.id, email: user.email } });
      return true;
    }

    // What the approve page shows about a code before it's approved: the PC's name and where it stands.
    if (path === "/api/cli/auth/info" && method === "GET") {
      const d = await this.store.deviceByUserCode(String(url.searchParams.get("code") ?? "").toUpperCase());
      const state = !d ? "unknown" : d.expiresAt <= Date.now() ? "expired" : d.status;
      send(200, { state, hostname: d && state !== "unknown" ? d.hostname : null });
      return true;
    }

    if (path === "/api/cli/auth/approve" && method === "POST") {
      if (!this.verify) throw new HttpError(503, "Sign-in isn't set up on this server (CLERK_SECRET_KEY)", "sign_in_off");
      if (!this.approvals.ok(addressOf(req))) throw new HttpError(429, "Too many tries. Wait a minute.", "rate_limited");
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1].trim();
      if (!token) throw new HttpError(401, "Sign in first", "not_signed_in");
      let person;
      try {
        person = await this.verify(token);
      } catch (e) {
        if (e instanceof NotSignedIn) throw new HttpError(401, `Sign in again (${e.message})`, "not_signed_in");
        throw e;
      }
      const body = (await readBody()) as { user_code?: unknown; approve?: unknown };
      const d = await this.store.deviceByUserCode(String(body?.user_code ?? "").toUpperCase());
      if (!d || d.expiresAt <= Date.now()) throw new HttpError(410, "This code expired. Get a new one in the app.", "expired");
      const user = await this.store.upsertUser(person);
      const approve = body?.approve === true;
      if (!(await this.store.decideDevice(d.id, approve ? "approved" : "denied", approve ? user.id : null)))
        throw new HttpError(409, "This code was already used.", "used");
      send(200, { ok: true, approved: approve, email: user.email });
      return true;
    }

    return false;
  }

  /** GET /api/user/profile, as Horafirm answers it: who the key belongs to. */
  async profile(owner: string) {
    const u = await this.store.user(owner);
    if (u) return { id: u.id, email: u.email, full_name: u.name };
    // A development key from DESKWISP_API_KEYS: its name is all there is.
    return { id: owner, email: null, full_name: owner };
  }
}
