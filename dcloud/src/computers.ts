import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import * as desk from "./desktop.ts";
import { BoxGone, type Box, type Provider } from "./providers/types.ts";
import { PLANS, type Tier } from "./plans.ts";
import { newVncPassword, type Computer, type Store } from "./store.ts";

/**
 * The computers API, in the shape the app already speaks (Horafirm's REST API, lib/server/horafirm.ts), so the
 * app only needs DESKWISP_HORAFIRM_ORIGIN pointed here. Errors answer { error, code } with Horafirm's statuses.
 */

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Ctx = { owner: string; method: string; parts: string[]; query: URLSearchParams; body: () => Promise<unknown>; res: ServerResponse };

/**
 * A computer sleeps (its box paused: E2B bills nothing then) when nobody has used it for
 * DESKWISP_IDLE_MINUTES, or when its user puts it to sleep. Using it means a bot acting on it (a
 * command, a click, typing, a screen made or closed), the user driving it over the live view, or a
 * wake. Looking at it doesn't: a status read, a screen list or a screenshot of a sleeping computer
 * answers 409 computer_asleep (as Horafirm does) and leaves it asleep.
 */
export class Computers {
  private readonly cfg: Config;
  private readonly reg: Store;
  private readonly provider: Provider;
  private readonly planOf: (owner: string) => Promise<Tier>;
  /** Boxes this process has open (an open box is a connection, not a wake: it's kept while it's awake). */
  private readonly open = new Map<string, Promise<Box>>();
  /** Boxes whose screens this process has set up. */
  private readonly readied = new Set<string>();
  /** When each box was last used, and when its provider was last told so. */
  private readonly used = new Map<string, number>();
  private readonly told = new Map<string, number>();
  /** Boxes asleep, as far as this process knows (a status read checks with the provider too). */
  private readonly asleep = new Set<string>();
  /** When the provider was last asked whether each box is asleep. */
  private readonly checked = new Map<string, number>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(cfg: Config, reg: Store, provider: Provider, planOf: (owner: string) => Promise<Tier> = async () => "max_deskwisp") {
    this.cfg = cfg;
    this.reg = reg;
    this.provider = provider;
    this.planOf = planOf;
    // Each minute, a box nobody has used for the idle time goes to sleep (E2B would pause it on its
    // own timer too; this is the same rule, for every provider).
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  stop() {
    clearInterval(this.sweeper);
  }

  /** Someone used the box: it stays awake for the idle time from now. */
  touch(boxId: string) {
    const now = Date.now();
    this.used.set(boxId, now);
    if (now - (this.told.get(boxId) ?? 0) > 60_000) {
      this.told.set(boxId, now);
      void this.provider.keepAwake(boxId, this.cfg.idleMs).catch(() => {});
    }
  }

  async sweep(now = Date.now()) {
    for (const [boxId, at] of this.used) {
      if (now - at < this.cfg.idleMs || this.asleep.has(boxId)) continue;
      await this.sleep(boxId).catch((e: Error) => console.warn(`[dcloud] putting ${boxId} to sleep: ${e.message}`));
    }
  }

  private async sleep(boxId: string) {
    await this.provider.pause(boxId);
    this.asleep.add(boxId);
    this.open.delete(boxId);
    this.used.delete(boxId);
  }

  /**
   * Whether the box is asleep: what this process knows, checked with the provider (a cheap read, no
   * wake) at most every 30 seconds, since the provider may pause it on its own timer too.
   */
  private async sleeping(boxId: string) {
    if (this.asleep.has(boxId)) return true;
    if (this.open.has(boxId) && Date.now() - (this.checked.get(boxId) ?? 0) < 30_000) return false;
    const st = await this.provider.state(boxId);
    this.checked.set(boxId, Date.now());
    if (st === "gone") throw new HttpError(404, "Computer not found", "not_found");
    if (st === "paused") {
      this.asleep.add(boxId);
      this.open.delete(boxId);
    }
    return st === "paused";
  }

  /**
   * The box for a computer, with its screens up. `wake`: it's being used, so a sleeping box wakes and
   * counts as used; without it (a look), a sleeping box answers 409 computer_asleep and stays asleep.
   */
  async box(c: Computer, wake = false): Promise<Box> {
    if (!wake && (await this.sleeping(c.boxId))) throw new HttpError(409, "The computer is asleep", "computer_asleep");
    let p = this.open.get(c.boxId);
    if (!p) {
      p = this.provider.open(c.boxId);
      this.open.set(c.boxId, p);
      p.catch(() => this.open.delete(c.boxId));
    }
    let box: Box;
    try {
      box = await p;
    } catch (e) {
      if (e instanceof BoxGone) throw new HttpError(404, "Computer not found", "not_found");
      throw e;
    }
    this.asleep.delete(c.boxId);
    if (wake) this.touch(c.boxId);
    else if (!this.used.has(c.boxId)) this.used.set(c.boxId, Date.now());
    if (!this.readied.has(c.boxId)) {
      // A computer from before watch-only passwords gets one now.
      if (!c.viewPassword) {
        c.viewPassword = newVncPassword();
        await this.reg.setPasswords(c.id, c.vncPassword, c.viewPassword);
      }
      await desk.ready(box, c.vncPassword, c.viewPassword);
      this.readied.add(c.boxId);
    }
    return box;
  }

  /**
   * New VNC passwords for a computer (someone with Full access left, or was moved to View only): kept,
   * and put on the box now if it's awake (its VNC servers restart, so everyone connected reconnects
   * with what they're allowed now), else when it next wakes.
   */
  async repassword(c: Computer) {
    c.vncPassword = newVncPassword();
    c.viewPassword = newVncPassword();
    await this.reg.setPasswords(c.id, c.vncPassword, c.viewPassword);
    this.readied.delete(c.boxId);
    if (this.open.has(c.boxId) && !this.asleep.has(c.boxId)) await this.box(c).catch(() => {});
  }

  /** Whether a computer is asleep, without waking it (the watch page's list). */
  async asleepNow(c: Computer) {
    return this.sleeping(c.boxId).catch(() => false);
  }

  /** A computer, awake, with its screens: for the watch page, once someone opens it. */
  async wakeFor(c: Computer) {
    const box = await this.box(c, true);
    return desk.screens(box);
  }

  /** The user's plan, as the app reads it (GET /api/user/subscription). */
  private async limits(owner: string) {
    const tier = await this.planOf(owner);
    return { tier, ...PLANS[tier] };
  }

  private async mine(owner: string, id: string) {
    const c = await this.reg.computer(owner, id);
    if (!c) throw new HttpError(404, "Computer not found", "not_found");
    return c;
  }

  private view(c: Computer, status = "running") {
    return {
      id: c.id,
      name: c.name,
      status,
      cpu: c.cpu,
      ram: c.ram,
      os: "linux",
      workspace_id: c.workspaceId,
      project_id: c.workspaceId,
      vnc_password: c.vncPassword,
      // No WebRTC: the app streams over VNC (lib/server/horafirm.ts webrtc).
      instance_details: { id: c.id, webrtc: false },
    };
  }

  private async screenList(c: Computer) {
    const box = await this.box(c);
    return (await desk.screens(box)).map((s) => ({
      id: desk.screenIdOf(s.display),
      display: `:${s.display}`,
      width: s.width,
      height: s.height,
      default: s.display === 99,
      vnc_port: 5900 + s.display,
      ws_port: 5981 + s.display,
    }));
  }

  private display(query: URLSearchParams) {
    const d = desk.displayOf(query.get("screen"));
    if (d === null) throw new HttpError(400, "unknown screen", "bad_screen");
    return d;
  }

  /** Answers one request under /api. Returns false when the path isn't one of these. */
  async handle(ctx: Ctx): Promise<unknown | false> {
    const { owner, method, parts, query } = ctx;
    const [a, b, c, d] = parts;

    // ---- The plan the app reads (lib/server/plan.ts): Deskwisp's limits, until billing sets them per user.
    if (a === "user" && b === "subscription" && method === "GET") {
      const p = await this.limits(owner);
      return { tier: p.tier, name: p.name, planLimits: { maxDesktops: p.computers, maxScreens: p.screens } };
    }
    if (a === "billing" && b === "compute-limits" && method === "GET") {
      const p = await this.limits(owner);
      const mine = await this.reg.computers(owner);
      const ram = mine.reduce((n, x) => n + x.ram, 0);
      return {
        max_computers: p.computers,
        computers_used: mine.length,
        max_screens: p.screens,
        account_ram_budget_gb: p.computers * this.cfg.ramGb,
        account_ram_used_gb: ram,
        max_ram_gb: this.cfg.ramGb,
      };
    }

    // ---- Workspaces: each owner's own; nobody else's, and no sharing yet.
    if (a === "workspaces") {
      if (!b && method === "GET")
        return {
          workspaces: await Promise.all(
            (await this.reg.workspaces(owner)).map(async (w) => ({
              id: w.id,
              name: w.name,
              role: "owner",
              // The owner and everyone they let in (People; invites aren't in yet).
              member_count: 1 + (await this.reg.members(w.id)).filter((m) => m.userId).length,
            })),
          ),
        };
      if (!b && method === "POST") {
        const body = (await ctx.body()) as { name?: string };
        const w = await this.reg.addWorkspace(owner, String(body?.name ?? "deskwisp").slice(0, 60));
        return { id: w.id, name: w.name };
      }
      const w = b ? await this.reg.workspace(owner, b) : null;
      if (!w) throw new HttpError(404, "Workspace not found", "not_found");
      if (!c && method === "GET") return { id: w.id, name: w.name, desktops: (await this.reg.computers(owner, w.id)).map((x) => ({ id: x.id, name: x.name })) };
      throw new HttpError(404, "Not found", "not_found");
    }

    if (a === "egress-devices") throw new HttpError(403, "Not available", "not_available");

    if (a !== "computers") return false;

    // ---- Create.
    if (!b && method === "POST") {
      const body = (await ctx.body()) as { workspace_id?: string; name?: string; ram?: number };
      const w = body?.workspace_id ? await this.reg.workspace(owner, body.workspace_id) : null;
      if (!w) throw new HttpError(404, "Workspace not found", "not_found");
      const p = await this.limits(owner);
      if ((await this.reg.computers(owner)).length >= Math.min(p.computers, this.cfg.maxComputers))
        throw new HttpError(403, `Your plan includes ${p.computers} computer${p.computers === 1 ? "" : "s"}`, "COMPUTER_LIMIT");
      return this.view(await this.create(owner, w.id, String(body?.name ?? "Computer").slice(0, 80)));
    }

    const comp = b ? await this.mine(owner, b) : null;
    if (!comp) return false;

    if (!c) {
      if (method === "GET") {
        // Horafirm's word for a computer asleep is "suspended": the app shows it asleep and leaves it be.
        return this.view(comp, (await this.sleeping(comp.boxId)) ? "suspended" : "running");
      }
      if (method === "DELETE") {
        await this.provider.kill(comp.boxId).catch((e) => {
          if (!(e instanceof BoxGone)) throw e;
        });
        this.open.delete(comp.boxId);
        this.readied.delete(comp.boxId);
        this.used.delete(comp.boxId);
        this.asleep.delete(comp.boxId);
        await this.reg.removeComputer(comp.id);
        return { ok: true };
      }
    }

    switch (c) {
      case "resize":
        if (method === "GET") return { current_disk_gb: 20, max_disk_gb: 20 };
        return { ok: true };
      case "webrtc":
        throw new HttpError(409, "WebRTC isn't available on Deskwisp computers", "webrtc_unavailable");
      case "resume":
        await this.box(comp, true);
        return { waking: false };
      // Put to sleep by its user: nothing runs, nothing is billed, and it all comes back on the next use.
      case "suspend":
        if (method !== "POST") break;
        if (!(await this.sleeping(comp.boxId))) await this.sleep(comp.boxId);
        return { ok: true, status: "suspended" };
      case "fork":
        throw new HttpError(409, "This computer can't be forked", "NOT_FORKABLE");
      case "clone": {
        const body = (await ctx.body()) as { name?: string };
        const p = await this.limits(owner);
        if ((await this.reg.computers(owner)).length >= Math.min(p.computers, this.cfg.maxComputers))
          throw new HttpError(403, `Your plan includes ${p.computers} computer${p.computers === 1 ? "" : "s"}`, "COMPUTER_LIMIT");
        // A fresh computer from the template: what the app needs from a clone is a computer of its own.
        return this.view(await this.create(owner, comp.workspaceId, String(body?.name ?? `${comp.name} copy`).slice(0, 80)));
      }
      case "screens": {
        if (!d && method === "GET") return { screens: await this.screenList(comp) };
        if (!d && method === "POST") {
          // A computer runs at most its four displays at once, on every plan: the plan sets how many
          // screens each bot has (the app opens them as they're needed, and asks for which display).
          const body = (await ctx.body()) as { width?: number; height?: number; display?: number };
          const box = await this.box(comp, true);
          const s = await desk.addScreen(box, body?.width || desk.SCREEN.width, body?.height || desk.SCREEN.height, Number(body?.display) || undefined);
          if (!s) throw new HttpError(409, "All four screens are in use", "screen_limit");
          return { id: desk.screenIdOf(s.display), display: `:${s.display}`, width: s.width, height: s.height, default: false, vnc_port: 5900 + s.display, ws_port: 5981 + s.display };
        }
        const n = desk.displayOf(d);
        if (n === null) throw new HttpError(404, "Screen not found", "not_found");
        if (method === "PATCH") return { ok: true };
        if (method === "DELETE") {
          if (n === 99) throw new HttpError(409, "The boot screen stays", "boot_screen");
          await desk.removeScreen(await this.box(comp, true), n);
          return { ok: true };
        }
        break;
      }
      case "bash": {
        const body = (await ctx.body()) as { command?: string; timeout?: number };
        if (typeof body?.command !== "string") throw new HttpError(400, "command is required", "bad_request");
        const timeout = Math.min(Math.max(Number(body.timeout) || 60, 1), 600);
        const r = await (await this.box(comp, true)).exec(body.command, timeout);
        return { output: r.output, exit_code: r.exitCode };
      }
      case "click": {
        const body = (await ctx.body()) as { x?: number; y?: number; double?: boolean };
        await desk.click(await this.box(comp, true), this.display(query), Number(body?.x) || 0, Number(body?.y) || 0, !!body?.double);
        return { ok: true };
      }
      case "type": {
        const body = (await ctx.body()) as { text?: string };
        await desk.type(await this.box(comp, true), this.display(query), String(body?.text ?? ""));
        return { ok: true };
      }
      case "key": {
        const body = (await ctx.body()) as { key?: string };
        await desk.key(await this.box(comp, true), this.display(query), String(body?.key ?? ""));
        return { ok: true };
      }
      case "screenshot": {
        const format = query.get("format") === "png" ? "png" : "jpeg";
        const bytes = await desk.screenshot(await this.box(comp), this.display(query), Number(query.get("scale") ?? 1), format);
        ctx.res.writeHead(200, { "Content-Type": format === "png" ? "image/png" : "image/jpeg", "Cache-Control": "no-store" });
        ctx.res.end(Buffer.from(bytes));
        return undefined;
      }
      case "egress":
      case "residential-proxy":
        throw new HttpError(403, "Not available", "not_available");
    }
    throw new HttpError(404, "Not found", "not_found");
  }

  private async create(owner: string, workspaceId: string, name: string) {
    const box = await this.provider.create({ cpu: this.cfg.cpu, ramGb: this.cfg.ramGb, meta: { owner, name } });
    const c = await this.reg.addComputer({ owner, workspaceId, name, boxId: box.id, provider: this.provider.name, cpu: this.cfg.cpu, ram: this.cfg.ramGb });
    this.open.set(box.id, Promise.resolve(box));
    this.touch(box.id);
    try {
      await desk.ready(box, c.vncPassword, c.viewPassword);
      this.readied.add(box.id);
    } catch (e) {
      // A computer whose screens never came up is no use: it goes, and the app is told why.
      await this.provider.kill(box.id).catch(() => {});
      await this.reg.removeComputer(c.id);
      throw new HttpError(503, (e as Error).message, "computer_failed");
    }
    return c;
  }

  /** The URL of a computer's VNC bridge for one screen, for the live view proxy. */
  async bridge(computerId: string, token: string, screenId: string | null) {
    const c = await this.reg.anyComputer(computerId);
    if (!c || !token || token !== c.vncPassword) return null;
    return this.bridgeFor(c, screenId);
  }

  /** The bridge for a computer someone may already watch (the watch page's ticket says so). */
  async bridgeFor(c: Computer, screenId: string | null) {
    const display = desk.displayOf(screenId);
    if (display === null) return null;
    // Opening the live view is someone at the computer: it wakes, and stays awake while they're on it.
    const box = await this.box(c, true);
    return { url: box.portUrl(5981 + display).replace(/^http/, "ws"), boxId: c.boxId };
  }
}

/** Reads a JSON body (at most 10 MB). */
export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 10 * 1024 * 1024) {
        reject(new HttpError(413, "body too large", "too_large"));
        req.destroy();
      } else chunks.push(d);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "body isn't JSON", "bad_json"));
      }
    });
    req.on("error", reject);
  });
}
