import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { isTier, type Tier } from "./plans.ts";
import { newVncPassword, WorkspaceTaken, type Computer, type Credit, type DeviceCode, type Member, type Store, type User, type Workspace } from "./store.ts";

/**
 * The store in Postgres (Neon): DATABASE_URL. At start it applies dcloud/db/*.sql that haven't run,
 * in order, each once (deskwisp.migrations), under an advisory lock so two servers starting at once
 * don't both apply one.
 */

const ms = (d: Date | null) => (d ? d.getTime() : 0);

type Row = Record<string, unknown>;
const user = (r: Row): User => ({
  id: r.id as string,
  clerkId: r.clerk_id as string,
  email: (r.email as string) ?? null,
  name: (r.name as string) ?? null,
  plan: isTier(r.plan) ? r.plan : "free_deskwisp",
  createdAt: ms(r.created_at as Date),
});
const workspace = (r: Row): Workspace => ({ id: r.id as string, owner: r.owner as string, name: r.name as string, createdAt: ms(r.created_at as Date) });
const computer = (r: Row): Computer => ({
  id: r.id as string,
  owner: r.owner as string,
  workspaceId: r.workspace_id as string,
  name: r.name as string,
  boxId: r.box_id as string,
  provider: r.provider as string,
  vncPassword: r.vnc_password as string,
  viewPassword: (r.view_password as string) ?? "",
  cpu: r.cpu as number,
  ram: r.ram as number,
  createdAt: ms(r.created_at as Date),
});
const member = (r: Row): Member => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  email: r.email as string,
  role: r.role === "admin" ? "admin" : "member",
  userId: (r.user_id as string) ?? null,
  token: (r.token as string) ?? null,
  createdAt: ms(r.created_at as Date),
  expiresAt: r.expires_at ? ms(r.expires_at as Date) : null,
});
const device = (r: Row): DeviceCode => ({
  id: r.id as string,
  deviceHash: r.device_hash as string,
  userCode: r.user_code as string,
  hostname: r.hostname as string,
  status: r.status as DeviceCode["status"],
  userId: (r.user_id as string) ?? null,
  expiresAt: ms(r.expires_at as Date),
  createdAt: ms(r.created_at as Date),
});

export class PgStore implements Store {
  readonly kind = "postgres";
  private readonly pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async open(url: string): Promise<PgStore> {
    // Neon closes idle connections on its side; a small pool that lets them go is enough here.
    // Neon's strings say sslmode=require, which pg already treats as verify-full (and warns about):
    // say verify-full outright, the check it does today and keeps doing.
    const connectionString = url.replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, "$1verify-full");
    const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    pool.on("error", (e) => console.warn(`[dcloud] database: ${e.message}`));
    const store = new PgStore(pool);
    await store.migrate(connectionString);
    return store;
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Migrations run on a direct connection, not Neon's pooler (PgBouncer in transaction mode), which
   * hands each statement outside a transaction to any server connection: an advisory lock, and what's
   * read before the work, could land on different sessions. Neon's direct host is the pooled one
   * without "-pooler". Any other Postgres is used as given. Every migration is also safe to run again.
   */
  private async migrate(url: string) {
    const dir = new URL("../db/", import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    const c = new pg.Client({ connectionString: directUrl(url), connectionTimeoutMillis: 15_000 });
    await c.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext('deskwisp.migrations'))");
      await c.query("CREATE SCHEMA IF NOT EXISTS deskwisp");
      await c.query("CREATE TABLE IF NOT EXISTS deskwisp.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await c.query("SELECT name FROM deskwisp.migrations")).rows.map((r) => r.name as string));
      for (const f of files) {
        if (done.has(f)) continue;
        await c.query("BEGIN");
        try {
          await c.query(readFileSync(new URL(f, dir), "utf8"));
          await c.query("INSERT INTO deskwisp.migrations (name) VALUES ($1)", [f]);
          await c.query("COMMIT");
          console.log(`[dcloud] database: applied ${f}`);
        } catch (e) {
          await c.query("ROLLBACK");
          throw new Error(`migration ${f}: ${(e as Error).message}`);
        }
      }
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('deskwisp.migrations'))").catch(() => {});
      await c.end().catch(() => {});
    }
  }

  private async rows(sql: string, args: unknown[] = []) {
    return (await this.pool.query(sql, args)).rows as Row[];
  }

  async upsertUser(u: { clerkId: string; email: string | null; name: string | null }) {
    const [r] = await this.rows(
      `INSERT INTO deskwisp.users (id, clerk_id, email, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (clerk_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING *`,
      [randomUUID(), u.clerkId, u.email, u.name],
    );
    return user(r);
  }

  async user(id: string) {
    const [r] = await this.rows("SELECT * FROM deskwisp.users WHERE id = $1", [id]);
    return r ? user(r) : null;
  }

  async userByEmail(email: string) {
    const [r] = await this.rows("SELECT * FROM deskwisp.users WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1", [email]);
    return r ? user(r) : null;
  }

  async computerSeconds(owner: string, month: string) {
    const [r] = await this.rows("SELECT seconds FROM deskwisp.computer_time WHERE owner = $1 AND month = $2", [owner, month]);
    return r ? Number(r.seconds) : 0;
  }

  async addComputerSeconds(owner: string, month: string, seconds: number) {
    if (!(seconds > 0)) return;
    await this.rows(
      `INSERT INTO deskwisp.computer_time (owner, month, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (owner, month) DO UPDATE SET seconds = deskwisp.computer_time.seconds + EXCLUDED.seconds, updated_at = now()`,
      [owner, month, Math.round(seconds)],
    );
  }

  async credit(userId: string): Promise<Credit> {
    const [b] = await this.rows("SELECT public.deskwisp_ai_credit_balance($1::uuid) AS left", [userId]);
    const [r] = await this.rows("SELECT plan_micros, plan_expires_at, free_micros FROM public.deskwisp_ai_credit WHERE user_id = $1", [userId]);
    const grants = await this.rows(
      "SELECT kind, tier, amount_micros, created_at FROM public.deskwisp_ai_credit_grants WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10",
      [userId],
    );
    const ends = r?.plan_expires_at ? ms(r.plan_expires_at as Date) : null;
    const plan = ends && ends > Date.now() ? Number(r?.plan_micros ?? 0) : 0;
    return {
      leftMicros: Number(b?.left ?? 0),
      planLeftMicros: plan,
      planEndsAt: plan ? ends : null,
      freeLeftMicros: Number(r?.free_micros ?? 0),
      grants: grants.map((g) => ({ kind: g.kind as string, tier: g.tier as string, amountMicros: Number(g.amount_micros), at: ms(g.created_at as Date) })),
    };
  }

  async grantPlan(userId: string, tier: Tier, invoice: string, amountMicros: number, start: number, end: number) {
    const [r] = await this.rows("SELECT public.deskwisp_ai_credit_grant_plan($1::uuid, $2, $3, $4::bigint, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0)) AS added", [
      userId,
      invoice,
      tier,
      Math.round(amountMicros),
      start,
      end,
    ]);
    return r?.added === null || r?.added === undefined ? null : Number(r.added);
  }

  async setPlan(userId: string, plan: Tier) {
    await this.rows("UPDATE deskwisp.users SET plan = $2 WHERE id = $1", [userId, plan]);
  }

  async addKey(userId: string, keyHash: string, label: string) {
    await this.rows("INSERT INTO deskwisp.app_keys (key_hash, user_id, label) VALUES ($1, $2, $3)", [keyHash, userId, label]);
  }

  async ownerOfKey(keyHash: string) {
    // Marks it used, at most once a minute, so the row isn't written on every request.
    const [r] = await this.rows(
      `UPDATE deskwisp.app_keys SET last_used_at = now()
       WHERE key_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
       RETURNING user_id`,
      [keyHash],
    );
    if (r) return r.user_id as string;
    const [k] = await this.rows("SELECT user_id FROM deskwisp.app_keys WHERE key_hash = $1", [keyHash]);
    return k ? (k.user_id as string) : null;
  }

  async revokeKeys(userId: string) {
    return (await this.pool.query("DELETE FROM deskwisp.app_keys WHERE user_id = $1", [userId])).rowCount ?? 0;
  }

  async addDeviceCode(d: DeviceCode) {
    await this.rows(
      `INSERT INTO deskwisp.device_codes (id, device_hash, user_code, hostname, status, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.id, d.deviceHash, d.userCode, d.hostname, d.status, d.userId, new Date(d.expiresAt), new Date(d.createdAt)],
    );
  }

  async deviceByUserCode(userCode: string) {
    const [r] = await this.rows("SELECT * FROM deskwisp.device_codes WHERE user_code = $1", [userCode]);
    return r ? device(r) : null;
  }

  async deviceByHash(deviceHash: string) {
    const [r] = await this.rows("SELECT * FROM deskwisp.device_codes WHERE device_hash = $1", [deviceHash]);
    return r ? device(r) : null;
  }

  async decideDevice(id: string, status: "approved" | "denied", userId: string | null) {
    const r = await this.pool.query(
      "UPDATE deskwisp.device_codes SET status = $2, user_id = $3 WHERE id = $1 AND status = 'pending' AND expires_at > now()",
      [id, status, userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async takeApproved(id: string) {
    const [r] = await this.rows("DELETE FROM deskwisp.device_codes WHERE id = $1 AND status = 'approved' RETURNING user_id", [id]);
    return r ? (r.user_id as string) : null;
  }

  async sweepDevices(now: number) {
    await this.rows("DELETE FROM deskwisp.device_codes WHERE expires_at <= $1", [new Date(now)]);
  }

  async workspaces(owner: string) {
    return (await this.rows("SELECT * FROM deskwisp.workspaces WHERE owner = $1 ORDER BY created_at", [owner])).map(workspace);
  }

  async addWorkspace(owner: string, name: string) {
    try {
      const [r] = await this.rows("INSERT INTO deskwisp.workspaces (id, owner, name) VALUES ($1, $2, $3) RETURNING *", [randomUUID(), owner, name]);
      return workspace(r);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new WorkspaceTaken();
      throw e;
    }
  }

  async workspace(owner: string, id: string) {
    if (!isUuid(id)) return null;
    const [r] = await this.rows("SELECT * FROM deskwisp.workspaces WHERE owner = $1 AND id = $2", [owner, id]);
    return r ? workspace(r) : null;
  }

  async computers(owner: string, workspaceId?: string) {
    if (workspaceId && !isUuid(workspaceId)) return [];
    const rows = workspaceId
      ? await this.rows("SELECT * FROM deskwisp.computers WHERE owner = $1 AND workspace_id = $2 ORDER BY created_at", [owner, workspaceId])
      : await this.rows("SELECT * FROM deskwisp.computers WHERE owner = $1 ORDER BY created_at", [owner]);
    return rows.map(computer);
  }

  async computer(owner: string, id: string) {
    if (!isUuid(id)) return null;
    const [r] = await this.rows("SELECT * FROM deskwisp.computers WHERE owner = $1 AND id = $2", [owner, id]);
    return r ? computer(r) : null;
  }

  async anyComputer(id: string) {
    if (!isUuid(id)) return null;
    const [r] = await this.rows("SELECT * FROM deskwisp.computers WHERE id = $1", [id]);
    return r ? computer(r) : null;
  }

  async addComputer(c: Omit<Computer, "id" | "createdAt" | "vncPassword" | "viewPassword">) {
    const [r] = await this.rows(
      `INSERT INTO deskwisp.computers (id, owner, workspace_id, name, box_id, provider, vnc_password, view_password, cpu, ram)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [randomUUID(), c.owner, c.workspaceId, c.name, c.boxId, c.provider, newVncPassword(), newVncPassword(), c.cpu, c.ram],
    );
    return computer(r);
  }

  async removeComputer(id: string) {
    if (!isUuid(id)) return;
    await this.rows("DELETE FROM deskwisp.computers WHERE id = $1", [id]);
  }

  async setPasswords(id: string, vncPassword: string, viewPassword: string) {
    if (!isUuid(id)) return;
    await this.rows("UPDATE deskwisp.computers SET vnc_password = $2, view_password = $3 WHERE id = $1", [id, vncPassword, viewPassword]);
  }

  async anyWorkspace(id: string) {
    if (!isUuid(id)) return null;
    const [r] = await this.rows("SELECT * FROM deskwisp.workspaces WHERE id = $1", [id]);
    return r ? workspace(r) : null;
  }

  async members(workspaceId: string) {
    if (!isUuid(workspaceId)) return [];
    return (await this.rows("SELECT * FROM deskwisp.members WHERE workspace_id = $1 ORDER BY created_at", [workspaceId])).map(member);
  }

  async putInvite(workspaceId: string, email: string, role: Member["role"], token: string, expiresAt: number) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const taken = await c.query("SELECT 1 FROM deskwisp.members WHERE workspace_id = $1 AND lower(email) = lower($2) AND user_id IS NOT NULL", [workspaceId, email]);
      if (taken.rowCount) throw new Error("already a member");
      await c.query("DELETE FROM deskwisp.members WHERE workspace_id = $1 AND lower(email) = lower($2)", [workspaceId, email]);
      const r = await c.query(
        "INSERT INTO deskwisp.members (id, workspace_id, email, role, token, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [randomUUID(), workspaceId, email, role, token, new Date(expiresAt)],
      );
      await c.query("COMMIT");
      return member(r.rows[0] as Row);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async dropInvite(workspaceId: string, email: string) {
    if (!isUuid(workspaceId)) return false;
    const r = await this.pool.query("DELETE FROM deskwisp.members WHERE workspace_id = $1 AND lower(email) = lower($2) AND user_id IS NULL", [workspaceId, email]);
    return (r.rowCount ?? 0) > 0;
  }

  async dropMember(workspaceId: string, userId: string) {
    if (!isUuid(workspaceId) || !isUuid(userId)) return null;
    const [r] = await this.rows("DELETE FROM deskwisp.members WHERE workspace_id = $1 AND user_id = $2 RETURNING *", [workspaceId, userId]);
    return r ? member(r) : null;
  }

  async setMemberRole(workspaceId: string, userId: string, role: Member["role"]) {
    if (!isUuid(workspaceId) || !isUuid(userId)) return null;
    const [r] = await this.rows("UPDATE deskwisp.members SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING *", [workspaceId, userId, role]);
    return r ? member(r) : null;
  }

  async inviteByToken(token: string) {
    const [r] = await this.rows("SELECT * FROM deskwisp.members WHERE token = $1 AND user_id IS NULL", [token]);
    return r ? member(r) : null;
  }

  async acceptInvite(id: string, userId: string) {
    const r = await this.pool.query("UPDATE deskwisp.members SET user_id = $2, token = NULL, expires_at = NULL WHERE id = $1 AND user_id IS NULL", [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async memberships(userId: string) {
    if (!isUuid(userId)) return [];
    return (await this.rows("SELECT * FROM deskwisp.members WHERE user_id = $1 ORDER BY created_at", [userId])).map(member);
  }
}

/** Ids from a URL are checked before they reach a uuid column, which would throw on anything else. */
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Neon's direct connection for a pooled one (its host without "-pooler"); any other URL as it is. */
export function directUrl(url: string) {
  try {
    const u = new URL(url);
    if (/\.neon\.tech$/i.test(u.hostname) && /-pooler\./i.test(u.hostname)) u.hostname = u.hostname.replace(/-pooler\./i, ".");
    return u.toString();
  } catch {
    return url;
  }
}
