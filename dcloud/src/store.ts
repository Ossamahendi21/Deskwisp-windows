import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isTier, monthOf, nextMonthStart, PLANS, type Tier } from "./plans.ts";

/**
 * What Deskwisp Cloud keeps: its users (signed in with Clerk), the keys their apps hold, the codes of
 * sign-ins under way, and who owns which workspace and computer. Two ways to keep it behind one
 * interface: Postgres (Neon, store-pg.ts) when DATABASE_URL is set, else a JSON file for development
 * and tests.
 *
 * An app key is never kept, only its SHA-256: the app holds the key, the store can only check it.
 */

export type User = { id: string; clerkId: string; email: string | null; name: string | null; plan: Tier; createdAt: number };

export type Computer = {
  id: string;
  owner: string;
  workspaceId: string;
  name: string;
  /** The provider's id for the box. */
  boxId: string;
  provider: string;
  /** Opens the live view (the app passes it as ?token=). */
  vncPassword: string;
  /** Opens it to watch only (x11vnc's view-only password), for people with View only. "" until made. */
  viewPassword: string;
  cpu: number;
  ram: number;
  createdAt: number;
};

export type Workspace = { id: string; owner: string; name: string; createdAt: number };

/**
 * A user's AI credit (db/005_ai_credit.sql), in micro-dollars: all that's left (below 0 when a task
 * overran it), what's left of this period's plan credit and when it ends, what's left of the credit
 * that never runs out (Free's one-time credit), and the kinds of the newest grants.
 */
/** A user's paid plan as Polar has it (billing.ts syncSubscription). Times in ms. */
export type Subscription = {
  userId: string;
  subscriptionId: string;
  tier: Tier;
  /** Polar's: incomplete, trialing, active, past_due, canceled, unpaid… */
  status: string;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  syncedAt: number;
};

export type Credit = { leftMicros: number; planLeftMicros: number; planEndsAt: number | null; freeLeftMicros: number; grants: { kind: string; tier: string; amountMicros: number; at: number }[] };

/**
 * Someone the owner of a workspace let in (People): "member" watches (View only), "admin" uses the
 * computers (Full access), Horafirm's words. Invited until they accept: no user yet, and a token for the link.
 */
export type Member = {
  id: string;
  workspaceId: string;
  email: string;
  role: "member" | "admin";
  userId: string | null;
  token: string | null;
  createdAt: number;
  expiresAt: number | null;
};

/** A sign-in under way: the app polls with the device code (kept hashed), the user approves the user code in the browser. */
export type DeviceCode = {
  id: string;
  deviceHash: string;
  userCode: string;
  /** The PC's name, shown on the approve page. */
  hostname: string;
  status: "pending" | "approved" | "denied";
  userId: string | null;
  expiresAt: number;
  createdAt: number;
};

export interface Store {
  readonly kind: "json" | "postgres";
  close(): Promise<void>;

  /** The user for a Clerk account, made on their first sign-in; their email and name follow Clerk's. */
  upsertUser(u: { clerkId: string; email: string | null; name: string | null }): Promise<User>;
  user(id: string): Promise<User | null>;
  /** A user by their email (any case), for the plan script. */
  userByEmail(email: string): Promise<User | null>;
  /** Put a user on a plan (billing does, step 2.4). */
  setPlan(userId: string, plan: Tier): Promise<void>;

  /** Seconds a user's computers ran in a month ("2026-10", UTC). */
  computerSeconds(owner: string, month: string): Promise<number>;
  addComputerSeconds(owner: string, month: string, seconds: number): Promise<void>;

  /** A user's AI credit, giving Free's one-time credit the first time it's asked (as cloud/ does). */
  credit(userId: string): Promise<Credit>;
  /**
   * A paid period's credit, once per invoice: the micros granted, or null when that invoice was granted
   * before. The first grant of a period sets the plan credit to it (nothing carried over); a later one
   * in the same period (an upgrade) adds what the period hasn't had yet.
   */
  grantPlan(userId: string, tier: Tier, invoice: string, amountMicros: number, start: number, end: number): Promise<number | null>;
  /**
   * AI credit added once (a top-up), to the credit that doesn't expire: the micros added, or null when
   * this payment (`ref`) was added before.
   */
  grantTopUp(userId: string, tier: Tier, ref: string, amountMicros: number): Promise<number | null>;
  subscription(userId: string): Promise<Subscription | null>;
  setSubscription(s: Subscription): Promise<void>;

  addKey(userId: string, keyHash: string, label: string): Promise<void>;
  /** Whose key this is (by its hash), or null. */
  ownerOfKey(keyHash: string): Promise<string | null>;
  /** Forget a user's keys (signed out everywhere): how many went. */
  revokeKeys(userId: string): Promise<number>;

  addDeviceCode(d: DeviceCode): Promise<void>;
  deviceByUserCode(userCode: string): Promise<DeviceCode | null>;
  deviceByHash(deviceHash: string): Promise<DeviceCode | null>;
  /** Approve or deny a pending, unexpired code: false when it isn't one any more. */
  decideDevice(id: string, status: "approved" | "denied", userId: string | null): Promise<boolean>;
  /** Take an approved code away, once: its user, or null when it was already taken (or isn't approved). */
  takeApproved(id: string): Promise<string | null>;
  /** Drop codes that ran out. */
  sweepDevices(now: number): Promise<void>;

  workspaces(owner: string): Promise<Workspace[]>;
  addWorkspace(owner: string, name: string): Promise<Workspace>;
  workspace(owner: string, id: string): Promise<Workspace | null>;
  computers(owner: string, workspaceId?: string): Promise<Computer[]>;
  computer(owner: string, id: string): Promise<Computer | null>;
  /** Any owner's computer by id, for the live view (its VNC password is the check there). */
  anyComputer(id: string): Promise<Computer | null>;
  addComputer(c: Omit<Computer, "id" | "createdAt" | "vncPassword" | "viewPassword">): Promise<Computer>;
  removeComputer(id: string): Promise<void>;
  /** New passwords for a computer (made for one from before view-only ones, or changed after someone left). */
  setPasswords(id: string, vncPassword: string, viewPassword: string): Promise<void>;

  /** A workspace by id, whoever owns it. */
  anyWorkspace(id: string): Promise<Workspace | null>;
  /** Everyone let into a workspace, and its invites. */
  members(workspaceId: string): Promise<Member[]>;
  /** Invite someone (again: a new token, role and expiry for the same email; never over someone already in). */
  putInvite(workspaceId: string, email: string, role: Member["role"], token: string, expiresAt: number): Promise<Member>;
  dropInvite(workspaceId: string, email: string): Promise<boolean>;
  /** Take someone's access away: the member they were, or null. */
  dropMember(workspaceId: string, userId: string): Promise<Member | null>;
  setMemberRole(workspaceId: string, userId: string, role: Member["role"]): Promise<Member | null>;
  inviteByToken(token: string): Promise<Member | null>;
  /** Accept an invite: false when it's gone or already taken. */
  acceptInvite(id: string, userId: string): Promise<boolean>;
  /** Where a user was let in. */
  memberships(userId: string): Promise<Member[]>;
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new app key: "dw_" and 32 random bytes. */
export const newAppKey = () => `dw_${randomBytes(32).toString("base64url")}`;

/** VNC passwords are at most 8 characters. */
export const newVncPassword = () => randomBytes(6).toString("base64url").slice(0, 8);

export class WorkspaceTaken extends Error {
  status = 409;
  constructor() {
    super("a workspace with that name exists");
  }
}

type Ledger = {
  plan: number;
  planEnds: number | null;
  free: number;
  grants: { kind: "free_signup" | "plan" | "topup"; tier: string; amount: number; invoice: string | null; end: number | null; at: number }[];
};

type Data = {
  computerTime: Record<string, number>;
  credit: Record<string, Ledger>;
  users: User[];
  keys: { hash: string; userId: string; label: string; createdAt: number }[];
  devices: DeviceCode[];
  computers: Computer[];
  workspaces: Workspace[];
  members: Member[];
  subscriptions?: Subscription[];
};

/** Everything in one JSON file: for development and the tests, one server, a handful of users. */
export class JsonStore implements Store {
  readonly kind = "json";
  private readonly file: string;
  private data: Data;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    const read = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Data>) : {};
    this.data = { computerTime: {}, credit: {}, users: [], keys: [], devices: [], computers: [], workspaces: [], members: [], ...read };
    for (const c of this.data.computers) c.viewPassword ??= "";
  }

  async close() {}

  private save() {
    const tmp = `${this.file}.${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async upsertUser(u: { clerkId: string; email: string | null; name: string | null }) {
    let user = this.data.users.find((x) => x.clerkId === u.clerkId);
    if (user) Object.assign(user, { email: u.email, name: u.name });
    else this.data.users.push((user = { id: randomUUID(), clerkId: u.clerkId, email: u.email, name: u.name, plan: "free_deskwisp", createdAt: Date.now() }));
    this.save();
    return { ...user, plan: isTier(user.plan) ? user.plan : "free_deskwisp" };
  }

  async user(id: string) {
    const u = this.data.users.find((x) => x.id === id);
    return u ? { ...u, plan: isTier(u.plan) ? u.plan : "free_deskwisp" } : null;
  }

  async userByEmail(email: string) {
    const u = this.data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    return u ? this.user(u.id) : null;
  }

  async setPlan(userId: string, plan: Tier) {
    const u = this.data.users.find((x) => x.id === userId);
    if (!u) return;
    u.plan = plan;
    this.save();
  }

  async computerSeconds(owner: string, month: string) {
    return this.data.computerTime[`${owner} ${month}`] ?? 0;
  }

  async addComputerSeconds(owner: string, month: string, seconds: number) {
    if (!(seconds > 0)) return;
    const k = `${owner} ${month}`;
    this.data.computerTime[k] = (this.data.computerTime[k] ?? 0) + Math.round(seconds);
    this.save();
  }

  /** The same math as db/005_ai_credit.sql and 006_free_monthly.sql, for development and the tests. */
  async credit(userId: string): Promise<Credit> {
    const l = (this.data.credit[userId] ??= { plan: 0, planEnds: null, free: 0, grants: [] });
    // Free's credit for this month, when no plan credit is running (a paid plan's left after a move to Free runs out first).
    const u = this.data.users.find((x) => x.id === userId);
    if (u && (u.plan ?? "free_deskwisp") === "free_deskwisp" && !(l.planEnds && l.planEnds > Date.now())) {
      const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      await this.grantPlan(userId, "free_deskwisp", `free:${userId}:${monthOf(start)}`, PLANS.free_deskwisp.creditMicros, start, nextMonthStart(start));
    }
    const plan = l.planEnds && l.planEnds > Date.now() ? l.plan : 0;
    return {
      leftMicros: plan + l.free,
      planLeftMicros: plan,
      planEndsAt: plan ? l.planEnds : null,
      freeLeftMicros: l.free,
      grants: [...l.grants].reverse().slice(0, 10).map((g) => ({ kind: g.kind, tier: g.tier, amountMicros: g.amount, at: g.at })),
    };
  }

  async grantPlan(userId: string, tier: Tier, invoice: string, amountMicros: number, start: number, end: number) {
    void start;
    const l = (this.data.credit[userId] ??= { plan: 0, planEnds: null, free: 0, grants: [] });
    if (l.grants.some((g) => g.invoice === invoice)) return null;
    const already = l.grants.filter((g) => g.kind === "plan" && g.end === end).reduce((n, g) => n + g.amount, 0);
    const add = Math.max(amountMicros - already, 0);
    l.grants.push({ kind: "plan", tier, amount: add, invoice, end, at: Date.now() });
    l.plan = already === 0 ? add : (l.planEnds && l.planEnds > Date.now() ? l.plan : 0) + add;
    l.planEnds = end;
    this.save();
    return add;
  }

  async grantTopUp(userId: string, tier: Tier, ref: string, amountMicros: number) {
    const l = (this.data.credit[userId] ??= { plan: 0, planEnds: null, free: 0, grants: [] });
    if (amountMicros <= 0 || l.grants.some((g) => g.invoice === ref)) return null;
    l.grants.push({ kind: "topup", tier, amount: amountMicros, invoice: ref, end: null, at: Date.now() });
    l.free += amountMicros;
    this.save();
    return amountMicros;
  }

  async subscription(userId: string) {
    return (this.data.subscriptions ?? []).find((s) => s.userId === userId) ?? null;
  }

  async setSubscription(s: Subscription) {
    this.data.subscriptions = [...(this.data.subscriptions ?? []).filter((x) => x.userId !== s.userId), { ...s }];
    this.save();
  }

  async addKey(userId: string, keyHash: string, label: string) {
    this.data.keys.push({ hash: keyHash, userId, label, createdAt: Date.now() });
    this.save();
  }

  async ownerOfKey(keyHash: string) {
    return this.data.keys.find((k) => k.hash === keyHash)?.userId ?? null;
  }

  async revokeKeys(userId: string) {
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => k.userId !== userId);
    this.save();
    return before - this.data.keys.length;
  }

  async addDeviceCode(d: DeviceCode) {
    this.data.devices.push({ ...d });
    this.save();
  }

  async deviceByUserCode(userCode: string) {
    const d = this.data.devices.find((x) => x.userCode === userCode);
    return d ? { ...d } : null;
  }

  async deviceByHash(deviceHash: string) {
    const d = this.data.devices.find((x) => x.deviceHash === deviceHash);
    return d ? { ...d } : null;
  }

  async decideDevice(id: string, status: "approved" | "denied", userId: string | null) {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d || d.status !== "pending" || d.expiresAt <= Date.now()) return false;
    d.status = status;
    d.userId = userId;
    this.save();
    return true;
  }

  async takeApproved(id: string) {
    const d = this.data.devices.find((x) => x.id === id && x.status === "approved");
    if (!d) return null;
    this.data.devices = this.data.devices.filter((x) => x !== d);
    this.save();
    return d.userId;
  }

  async sweepDevices(now: number) {
    const keep = this.data.devices.filter((d) => d.expiresAt > now);
    if (keep.length !== this.data.devices.length) {
      this.data.devices = keep;
      this.save();
    }
  }

  async workspaces(owner: string) {
    return this.data.workspaces.filter((w) => w.owner === owner);
  }

  async addWorkspace(owner: string, name: string) {
    const taken = this.data.workspaces.find((w) => w.owner === owner && w.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (taken) throw new WorkspaceTaken();
    const w = { id: randomUUID(), owner, name, createdAt: Date.now() };
    this.data.workspaces.push(w);
    this.save();
    return w;
  }

  async workspace(owner: string, id: string) {
    return this.data.workspaces.find((w) => w.owner === owner && w.id === id) ?? null;
  }

  async computers(owner: string, workspaceId?: string) {
    return this.data.computers.filter((c) => c.owner === owner && (!workspaceId || c.workspaceId === workspaceId));
  }

  async computer(owner: string, id: string) {
    return this.data.computers.find((c) => c.owner === owner && c.id === id) ?? null;
  }

  async anyComputer(id: string) {
    return this.data.computers.find((c) => c.id === id) ?? null;
  }

  async addComputer(c: Omit<Computer, "id" | "createdAt" | "vncPassword" | "viewPassword">) {
    const full: Computer = { ...c, id: randomUUID(), createdAt: Date.now(), vncPassword: newVncPassword(), viewPassword: newVncPassword() };
    this.data.computers.push(full);
    this.save();
    return full;
  }

  async removeComputer(id: string) {
    this.data.computers = this.data.computers.filter((c) => c.id !== id);
    this.save();
  }

  async setPasswords(id: string, vncPassword: string, viewPassword: string) {
    const c = this.data.computers.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, { vncPassword, viewPassword });
    this.save();
  }

  async anyWorkspace(id: string) {
    return this.data.workspaces.find((w) => w.id === id) ?? null;
  }

  async members(workspaceId: string) {
    return this.data.members.filter((m) => m.workspaceId === workspaceId).map((m) => ({ ...m }));
  }

  async putInvite(workspaceId: string, email: string, role: Member["role"], token: string, expiresAt: number) {
    const same = (m: Member) => m.workspaceId === workspaceId && m.email.toLowerCase() === email.toLowerCase();
    if (this.data.members.some((m) => same(m) && m.userId)) throw new Error("already a member");
    this.data.members = this.data.members.filter((m) => !same(m));
    const m: Member = { id: randomUUID(), workspaceId, email, role, userId: null, token, createdAt: Date.now(), expiresAt };
    this.data.members.push(m);
    this.save();
    return { ...m };
  }

  async dropInvite(workspaceId: string, email: string) {
    const before = this.data.members.length;
    this.data.members = this.data.members.filter((m) => !(m.workspaceId === workspaceId && !m.userId && m.email.toLowerCase() === email.toLowerCase()));
    this.save();
    return this.data.members.length < before;
  }

  async dropMember(workspaceId: string, userId: string) {
    const m = this.data.members.find((x) => x.workspaceId === workspaceId && x.userId === userId);
    if (!m) return null;
    this.data.members = this.data.members.filter((x) => x !== m);
    this.save();
    return { ...m };
  }

  async setMemberRole(workspaceId: string, userId: string, role: Member["role"]) {
    const m = this.data.members.find((x) => x.workspaceId === workspaceId && x.userId === userId);
    if (!m) return null;
    m.role = role;
    this.save();
    return { ...m };
  }

  async inviteByToken(token: string) {
    const m = this.data.members.find((x) => x.token === token && !x.userId);
    return m ? { ...m } : null;
  }

  async acceptInvite(id: string, userId: string) {
    const m = this.data.members.find((x) => x.id === id && !x.userId);
    if (!m) return false;
    Object.assign(m, { userId, token: null, expiresAt: null });
    this.save();
    return true;
  }

  async memberships(userId: string) {
    return this.data.members.filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }
}
