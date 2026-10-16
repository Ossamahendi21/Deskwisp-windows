import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NotSignedIn, frontendApi, type ClerkPerson, type Verifier } from "./clerk.ts";
import { HttpError, type Computers } from "./computers.ts";
import type { Config } from "./config.ts";
import { displayOf, screenIdOf } from "./desktop.ts";
import { acceptPage, watchPage } from "./watch-pages.ts";
import { PLANS, upgradeOf, type Tier } from "./plans.ts";
import type { Computer, Member, Store, User } from "./store.ts";

/**
 * People: the owner of a workspace lets others watch its computers (View only, Horafirm's "member") or use
 * them (Full access, "admin"), in their browser at /watch, on a phone too. The app's People sheet
 * (lib/server/members.ts) speaks Horafirm's member API here, so it needs nothing new:
 *
 *   GET    /api/workspaces/:id/members   everyone in, the invites, and the plan's seats
 *   POST   /api/workspaces/:id/invite    {email, permission: viewer|admin}: a link (and an email with Resend)
 *   DELETE /api/workspaces/:id/invite    {email}: cancel it
 *   PATCH  /api/workspaces/:id/members   {memberId, role: member|admin}
 *   DELETE /api/workspaces/:id/members   {memberId}
 *
 * Someone invited opens /accept-invite?token=…, signs in with Clerk as the email invited (only that
 * email can take it), and lands on /watch: their own bots' computers (anyone signed in sees those) and
 * the ones shared with them. Opening one wakes it and gives a ticket for its live view, good for a
 * couple of minutes to connect, and the computer's password for what they may do: the watch-only
 * one for View only (x11vnc refuses their clicks and keys), the full one for Full access and the owner.
 *
 * Taking someone's access away, or moving them to View only, closes their live views at once, and
 * after someone with Full access goes the computers get new passwords (a password they copied stops
 * working; the owner's app reads the new one on its next connection).
 *
 * Plans: Free lets nobody in, Pro 2 people, Max 5 (invites count until they're cancelled or expire).
 */

const INVITE_DAYS = 7;
const TICKET_S = 120;
const INVITES_PER_HOUR = 20;

type Role = "owner" | Member["role"];
type Ticket = { c: string; u: string; r: Role; e: number };

const emailOf = (v: unknown) => {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(e) ? e : null;
};

const NOVNC = (() => {
  // The noVNC that the app itself uses, from the repository's node_modules: served as it is, never fetched.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const d = join(dir, "node_modules", "@novnc", "novnc");
    if (existsSync(join(d, "core", "rfb.js"))) return d;
    dir = dirname(dir);
  }
  return null;
})();

export class People {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly computers: Computers;
  private readonly verify: Verifier | null;
  private readonly planOf: (owner: string) => Promise<Tier>;
  private readonly secret: Buffer;
  /** Live views opened with a ticket, by "<workspace>:<user>": closed when that person's access changes. */
  private readonly views = new Map<string, Set<() => void>>();
  private readonly sessions = new Map<string, { person: ClerkPerson; at: number }>();
  private readonly invitesSent = new Map<string, number[]>();
  private readonly send: (to: string, subject: string, text: string) => Promise<boolean>;

  constructor(
    cfg: Config,
    store: Store,
    computers: Computers,
    verify: Verifier | null,
    planOf: (owner: string) => Promise<Tier>,
    opts: { secret?: Buffer; send?: (to: string, subject: string, text: string) => Promise<boolean> } = {},
  ) {
    this.cfg = cfg;
    this.store = store;
    this.computers = computers;
    this.verify = verify;
    this.planOf = planOf;
    // Tickets live two minutes, so a secret made at start is enough: a restart only asks the page for a new one.
    this.secret = opts.secret ?? randomBytes(32);
    this.send = opts.send ?? ((to, subject, text) => this.resend(to, subject, text));
  }

  /* ---------------- The owner's side (the app's People sheet, with the app's key) ---------------- */

  /** Answers /api/workspaces/:id/(members|invite) for the workspace's owner; false when it's another path. */
  async handle(owner: string, method: string, parts: string[], body: () => Promise<unknown>): Promise<unknown | false> {
    const [a, id, what] = parts;
    if (a !== "workspaces" || !id || (what !== "members" && what !== "invite") || parts.length !== 3) return false;
    const w = await this.store.workspace(owner, id);
    if (!w) throw new HttpError(404, "Workspace not found", "not_found");

    if (what === "members" && method === "GET") return this.list(owner, w.id);

    if (what === "invite" && method === "POST") {
      const b = (await body()) as { email?: unknown; permission?: unknown };
      const email = emailOf(b?.email);
      if (!email) throw new HttpError(400, "Enter a valid email", "bad_email");
      const role: Member["role"] = b?.permission === "admin" ? "admin" : "member";
      const me = await this.store.user(owner);
      if (me?.email && me.email.toLowerCase() === email) throw new HttpError(400, "You can't invite yourself", "self");
      const all = await this.store.members(w.id);
      if (all.some((m) => m.userId && m.email.toLowerCase() === email)) throw new HttpError(400, "That person is already a member", "already_in");
      const tier = await this.planOf(owner);
      const limit = PLANS[tier].people;
      const resend = all.some((m) => !m.userId && m.email.toLowerCase() === email);
      const used = this.used(all);
      if (limit === 0) throw this.refusal(402, "UPGRADE_REQUIRED", `${PLANS[tier].name} doesn't include adding people`, tier);
      if (!resend && used >= limit) throw this.refusal(402, "SEAT_LIMIT", `${PLANS[tier].name} includes ${limit} people`, tier, { limit, used });
      if (!this.rateOk(owner)) throw new HttpError(429, "Too many invites. Try again in an hour.", "INVITE_RATE_LIMITED");
      const token = randomBytes(24).toString("base64url");
      await this.store.putInvite(w.id, email, role, token, Date.now() + INVITE_DAYS * 86_400_000);
      const url = this.acceptUrl(token, w.id);
      const who = me?.name || me?.email || "Someone";
      const sent = await this.send(
        email,
        `${who} invited you to their Deskwisp bots`,
        `${who} invited you to ${role === "admin" ? "use" : "watch"} their Deskwisp bots' computers, live in your browser.\n\n` +
          `Open this link and sign in as ${email} (it works for ${INVITE_DAYS} days):\n${url}\n`,
      ).catch(() => false);
      return { ok: true, email, email_sent: sent, accept_url: url };
    }

    if (what === "invite" && method === "DELETE") {
      const b = (await body()) as { email?: unknown };
      const email = emailOf(b?.email);
      if (!email || !(await this.store.dropInvite(w.id, email))) throw new HttpError(404, "Invite not found", "not_found");
      return { ok: true };
    }

    if (what === "members" && (method === "DELETE" || method === "PATCH")) {
      const b = (await body()) as { memberId?: unknown; role?: unknown };
      const userId = typeof b?.memberId === "string" ? b.memberId : "";
      if (method === "DELETE") {
        const gone = await this.store.dropMember(w.id, userId);
        if (!gone) throw new HttpError(404, "Member not found", "not_found");
        this.close(w.id, userId);
        if (gone.role === "admin") await this.newPasswords(owner, w.id);
        return { ok: true };
      }
      if (b?.role !== "member" && b?.role !== "admin") throw new HttpError(400, "role is member or admin", "bad_role");
      const before = (await this.store.members(w.id)).find((m) => m.userId === userId);
      if (!before || !(await this.store.setMemberRole(w.id, userId, b.role))) throw new HttpError(404, "Member not found", "not_found");
      // Their open views come back with what they may do now.
      this.close(w.id, userId);
      if (before.role === "admin" && b.role === "member") await this.newPasswords(owner, w.id);
      return { ok: true };
    }
    throw new HttpError(405, "Method not allowed", "method");
  }

  /** People who count against the plan: everyone in, and invites not run out. */
  private used(all: Member[]) {
    const now = Date.now();
    return all.filter((m) => m.userId || (m.expiresAt ?? Infinity) > now).length;
  }

  private refusal(status: number, code: string, message: string, tier: Tier, extra: Record<string, unknown> = {}) {
    const e = new HttpError(status, message, code) as HttpError & { extra?: Record<string, unknown> };
    e.extra = { upgradeTier: upgradeOf(tier), ...extra };
    return e;
  }

  private rateOk(owner: string) {
    const now = Date.now();
    const recent = (this.invitesSent.get(owner) ?? []).filter((t) => now - t < 3_600_000);
    recent.push(now);
    this.invitesSent.set(owner, recent);
    return recent.length <= INVITES_PER_HOUR;
  }

  private acceptUrl(token: string, workspaceId: string) {
    return `${this.cfg.publicUrl}/accept-invite?token=${encodeURIComponent(token)}&project_id=${encodeURIComponent(workspaceId)}`;
  }

  /** Horafirm's members answer: the owner first, then everyone in, the invites waiting, and the seats. */
  private async list(owner: string, workspaceId: string) {
    const me = await this.store.user(owner);
    const all = await this.store.members(workspaceId);
    const now = Date.now();
    const members = [
      { id: owner, role: "owner", email: me?.email ?? null, alt: me?.name ?? null },
      ...(await Promise.all(
        all
          .filter((m) => m.userId)
          .map(async (m) => {
            const u = await this.store.user(m.userId!);
            return { id: m.userId, role: m.role, email: u?.email ?? m.email, alt: u?.name ?? null };
          }),
      )),
    ];
    const invites = all
      .filter((m) => !m.userId)
      .map((m) => ({
        email: m.email,
        role: m.role,
        status: "pending",
        token: m.token,
        accept_url: m.token ? this.acceptUrl(m.token, workspaceId) : null,
        created_at: new Date(m.createdAt).toISOString(),
        expires_at: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
        expired: (m.expiresAt ?? Infinity) <= now,
      }));
    const tier = await this.planOf(owner);
    const limit = PLANS[tier].people;
    const used = this.used(all);
    return {
      members,
      invites,
      watch_url: `${this.cfg.publicUrl}/watch`,
      seats: {
        product: "deskwisp",
        plan: tier,
        can_add: used < limit,
        used,
        limit,
        upgrade_tier: upgradeOf(tier),
        caps: { pro_deskwisp: PLANS.pro_deskwisp.people, max_deskwisp: PLANS.max_deskwisp.people },
      },
    };
  }

  /** Someone with Full access left: every computer in the workspace gets new passwords. */
  private async newPasswords(owner: string, workspaceId: string) {
    for (const c of await this.store.computers(owner, workspaceId))
      await this.computers.repassword(c).catch((e: Error) => console.warn(`[people] new passwords for ${c.id}: ${e.message}`));
  }

  private close(workspaceId: string, userId: string) {
    const key = `${workspaceId}:${userId}`;
    for (const end of this.views.get(key) ?? []) end();
    this.views.delete(key);
  }

  private async resend(to: string, subject: string, text: string) {
    if (!this.cfg.resendApiKey || !this.cfg.mailFrom) return false;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.cfg.mailFrom, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[people] invite email to a recipient: Resend said ${res.status}`);
    return res.ok;
  }

  /* ---------------- The browser's side: accepting, and watching ---------------- */

  /** The pages and calls for people in their browser (signed in with Clerk); true when it was one. */
  async public(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<unknown>, send: (status: number, body: unknown) => void): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if ((path === "/accept-invite" || path === "/watch") && method === "GET") {
      const pk = this.cfg.clerkPublishableKey ?? null;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      });
      res.end((path === "/watch" ? watchPage : acceptPage)({ publishableKey: pk, frontendApi: pk ? frontendApi(pk) : null }));
      return true;
    }

    if (path.startsWith("/novnc/") && method === "GET") {
      this.novnc(path.slice("/novnc/".length), res);
      return true;
    }

    if (path === "/api/invites/accept" && method === "POST") {
      const user = await this.signedIn(req);
      const b = (await readBody()) as { token?: unknown };
      const m = typeof b?.token === "string" ? await this.store.inviteByToken(b.token) : null;
      if (!m) throw new HttpError(404, "This invite isn't there any more. Ask for a new one.", "gone");
      if ((m.expiresAt ?? Infinity) <= Date.now()) throw new HttpError(410, "This invite ran out. Ask for a new one.", "expired");
      const w = await this.store.anyWorkspace(m.workspaceId);
      if (!w) throw new HttpError(404, "This invite isn't there any more.", "gone");
      if (w.owner === user.id) throw new HttpError(400, "That's your own invite: you see your bots already.", "self");
      if ((user.email ?? "").toLowerCase() !== m.email.toLowerCase())
        throw new HttpError(403, `This invite is for ${m.email}. Sign in with that email.`, "wrong_email");
      if (!(await this.store.acceptInvite(m.id, user.id))) throw new HttpError(409, "This invite was already used.", "used");
      const owner = await this.store.user(w.owner);
      send(200, { ok: true, owner: owner?.name || owner?.email || "Someone", role: m.role });
      return true;
    }

    if (path === "/api/watch" && method === "GET") {
      const user = await this.signedIn(req);
      send(200, { you: user.email, computers: (await this.watchable(user)).map(({ id, name, owner, role, asleep }) => ({ id, name, owner, role, asleep })) });
      return true;
    }

    if (path === "/api/watch/open" && method === "POST") {
      const user = await this.signedIn(req);
      const b = (await readBody()) as { computerId?: unknown };
      const found = (await this.watchable(user)).find((x) => x.id === b?.computerId);
      if (!found) throw new HttpError(404, "You can't see that computer.", "not_found");
      const c = found.computer;
      const screens = await this.computers.wakeFor(c);
      // Read again after waking: a computer from before watch-only passwords gets its own then.
      const now = (await this.store.anyComputer(c.id)) ?? c;
      const ticket = this.sign({ c: c.id, u: user.id, r: found.role, e: Math.floor(Date.now() / 1000) + TICKET_S });
      send(200, {
        ticket,
        password: found.role === "member" ? now.viewPassword : now.vncPassword,
        viewOnly: found.role === "member",
        screens: screens.map((s) => ({ id: screenIdOf(s.display), number: [99, 100, 101, 102].indexOf(s.display) + 1 })),
      });
      return true;
    }

    return false;
  }

  /** The computers someone signed in may see: their own, and the ones shared with them (each with its record, never sent). */
  private async watchable(user: User) {
    type Row = { id: string; name: string; owner: string; role: Role; asleep: boolean; computer: Computer };
    const out: Row[] = [];
    for (const c of await this.store.computers(user.id))
      out.push({ id: c.id, name: c.name, owner: "You", role: "owner", asleep: await this.computers.asleepNow(c), computer: c });
    for (const m of await this.store.memberships(user.id)) {
      const w = await this.store.anyWorkspace(m.workspaceId);
      if (!w) continue;
      const o = await this.store.user(w.owner);
      for (const c of await this.store.computers(w.owner, w.id))
        out.push({ id: c.id, name: c.name, owner: o?.name || o?.email || "Someone", role: m.role, asleep: await this.computers.asleepNow(c), computer: c });
    }
    return out;
  }

  private async signedIn(req: IncomingMessage): Promise<User> {
    if (!this.verify) throw new HttpError(503, "Sign-in isn't set up on this server (CLERK_SECRET_KEY)", "sign_in_off");
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1].trim();
    if (!token) throw new HttpError(401, "Sign in first", "not_signed_in");
    let person = this.sessions.get(token);
    if (!person || Date.now() - person.at > 30_000) {
      try {
        person = { person: await this.verify(token), at: Date.now() };
      } catch (e) {
        if (e instanceof NotSignedIn) throw new HttpError(401, `Sign in again (${e.message})`, "not_signed_in");
        throw e;
      }
      if (this.sessions.size > 10_000) this.sessions.clear();
      this.sessions.set(token, person);
    }
    return this.store.upsertUser(person.person);
  }

  /* ---------------- Tickets for the live view ---------------- */

  private sign(t: Ticket) {
    const body = Buffer.from(JSON.stringify(t)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  private read(ticket: string): Ticket | null {
    const [body, mac] = ticket.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.secret).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket;
      return t.e * 1000 > Date.now() ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * The live view for a ticket: the bridge, and `opened` to call with the connection's close once it's
   * up (closed again when the person's access changes). Null when the ticket, or their access, isn't good.
   */
  async bridge(ticket: string, computerId: string, screenId: string | null) {
    const t = this.read(ticket);
    if (!t || t.c !== computerId || displayOf(screenId) === null) return null;
    const c = await this.store.anyComputer(t.c);
    if (!c) return null;
    let key = `${c.workspaceId}:${t.u}`;
    if (t.r === "owner") {
      if (c.owner !== t.u) return null;
      key = `owner:${t.u}`;
    } else {
      const m = (await this.store.memberships(t.u)).find((x) => x.workspaceId === c.workspaceId);
      // Moved to View only since the ticket: it's no good for more.
      if (!m || (t.r === "admin" && m.role !== "admin")) return null;
    }
    const target = await this.computers.bridgeFor(c, screenId);
    if (!target) return null;
    return {
      ...target,
      opened: (end: () => void) => {
        const set = this.views.get(key) ?? new Set();
        set.add(end);
        this.views.set(key, set);
        return () => set.delete(end);
      },
    };
  }

  /** noVNC's own files, from the app's copy: only .js under core/ and vendor/. */
  private novnc(rel: string, res: ServerResponse) {
    const clean = normalize(rel).replace(/^([/\\])+/, "");
    const ok = NOVNC && /^(core|vendor)[/\\]/.test(clean) && !clean.split(/[/\\]/).includes("..") && extname(clean) === ".js";
    const file = ok ? join(NOVNC!, clean) : "";
    if (!ok || !file.startsWith(NOVNC! + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return void res.end("not found");
    }
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(readFileSync(file));
  }
}
