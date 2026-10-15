import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import * as desk from "./desktop.ts";
import { BoxGone, type Box, type Provider } from "./providers/types.ts";
import type { Computer, Store } from "./store.ts";

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

export class Computers {
  private readonly cfg: Config;
  private readonly reg: Store;
  private readonly provider: Provider;
  /** Open boxes, kept a few minutes so each request doesn't reconnect. */
  private readonly open = new Map<string, { box: Promise<Box>; at: number }>();
  /** Boxes whose screens this process has set up. */
  private readonly readied = new Set<string>();

  constructor(cfg: Config, reg: Store, provider: Provider) {
    this.cfg = cfg;
    this.reg = reg;
    this.provider = provider;
  }

  /** The box for a computer, awake and with its screens up. */
  async box(c: Computer): Promise<Box> {
    const kept = this.open.get(c.boxId);
    let p = kept && Date.now() - kept.at < 5 * 60_000 ? kept.box : undefined;
    if (!p) {
      p = this.provider.open(c.boxId);
      this.open.set(c.boxId, { box: p, at: Date.now() });
      p.catch(() => this.open.delete(c.boxId));
    }
    let box: Box;
    try {
      box = await p;
    } catch (e) {
      if (e instanceof BoxGone) throw new HttpError(404, "Computer not found", "not_found");
      throw e;
    }
    void this.provider.keepAwake(c.boxId, this.cfg.idleMs).catch(() => {});
    if (!this.readied.has(c.boxId)) {
      await desk.ready(box, c.vncPassword);
      this.readied.add(c.boxId);
    }
    return box;
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
    if (a === "user" && b === "subscription" && method === "GET") return { tier: "deskwisp", planLimits: { maxDesktops: this.cfg.maxComputers } };
    if (a === "billing" && b === "compute-limits" && method === "GET") {
      const mine = await this.reg.computers(owner);
      const ram = mine.reduce((n, x) => n + x.ram, 0);
      return {
        max_computers: this.cfg.maxComputers,
        computers_used: mine.length,
        account_ram_budget_gb: this.cfg.maxComputers * this.cfg.ramGb,
        account_ram_used_gb: ram,
        max_ram_gb: this.cfg.ramGb,
      };
    }

    // ---- Workspaces: each owner's own; nobody else's, and no sharing yet.
    if (a === "workspaces") {
      if (!b && method === "GET") return { workspaces: (await this.reg.workspaces(owner)).map((w) => ({ id: w.id, name: w.name, role: "owner", member_count: 1 })) };
      if (!b && method === "POST") {
        const body = (await ctx.body()) as { name?: string };
        const w = await this.reg.addWorkspace(owner, String(body?.name ?? "deskwisp").slice(0, 60));
        return { id: w.id, name: w.name };
      }
      const w = b ? await this.reg.workspace(owner, b) : null;
      if (!w) throw new HttpError(404, "Workspace not found", "not_found");
      if (!c && method === "GET") return { id: w.id, name: w.name, desktops: (await this.reg.computers(owner, w.id)).map((x) => ({ id: x.id, name: x.name })) };
      throw new HttpError(403, "Sharing a workspace isn't available yet", "not_available");
    }

    if (a === "egress-devices") throw new HttpError(403, "Not available", "not_available");

    if (a !== "computers") return false;

    // ---- Create.
    if (!b && method === "POST") {
      const body = (await ctx.body()) as { workspace_id?: string; name?: string; ram?: number };
      const w = body?.workspace_id ? await this.reg.workspace(owner, body.workspace_id) : null;
      if (!w) throw new HttpError(404, "Workspace not found", "not_found");
      if ((await this.reg.computers(owner)).length >= this.cfg.maxComputers)
        throw new HttpError(403, `Your plan includes ${this.cfg.maxComputers} computers`, "COMPUTER_LIMIT");
      return this.view(await this.create(owner, w.id, String(body?.name ?? "Computer").slice(0, 80)));
    }

    const comp = b ? await this.mine(owner, b) : null;
    if (!comp) return false;

    if (!c) {
      if (method === "GET") {
        const state = await this.provider.state(comp.boxId);
        if (state === "gone") throw new HttpError(404, "Computer not found", "not_found");
        return this.view(comp, "running");
      }
      if (method === "DELETE") {
        await this.provider.kill(comp.boxId).catch((e) => {
          if (!(e instanceof BoxGone)) throw e;
        });
        this.open.delete(comp.boxId);
        this.readied.delete(comp.boxId);
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
        await this.box(comp);
        return { waking: false };
      case "fork":
        throw new HttpError(409, "This computer can't be forked", "NOT_FORKABLE");
      case "clone": {
        const body = (await ctx.body()) as { name?: string };
        if ((await this.reg.computers(owner)).length >= this.cfg.maxComputers)
          throw new HttpError(403, `Your plan includes ${this.cfg.maxComputers} computers`, "COMPUTER_LIMIT");
        // A fresh computer from the template: what the app needs from a clone is a computer of its own.
        return this.view(await this.create(owner, comp.workspaceId, String(body?.name ?? `${comp.name} copy`).slice(0, 80)));
      }
      case "screens": {
        if (!d && method === "GET") return { screens: await this.screenList(comp) };
        if (!d && method === "POST") {
          const body = (await ctx.body()) as { width?: number; height?: number };
          const s = await desk.addScreen(await this.box(comp), body?.width || desk.SCREEN.width, body?.height || desk.SCREEN.height);
          if (!s) throw new HttpError(409, "All four screens are in use", "screen_limit");
          return { id: desk.screenIdOf(s.display), display: `:${s.display}`, width: s.width, height: s.height, default: false, vnc_port: 5900 + s.display, ws_port: 5981 + s.display };
        }
        const n = desk.displayOf(d);
        if (n === null) throw new HttpError(404, "Screen not found", "not_found");
        if (method === "PATCH") return { ok: true };
        if (method === "DELETE") {
          if (n === 99) throw new HttpError(409, "The boot screen stays", "boot_screen");
          await desk.removeScreen(await this.box(comp), n);
          return { ok: true };
        }
        break;
      }
      case "bash": {
        const body = (await ctx.body()) as { command?: string; timeout?: number };
        if (typeof body?.command !== "string") throw new HttpError(400, "command is required", "bad_request");
        const timeout = Math.min(Math.max(Number(body.timeout) || 60, 1), 600);
        const r = await (await this.box(comp)).exec(body.command, timeout);
        return { output: r.output, exit_code: r.exitCode };
      }
      case "click": {
        const body = (await ctx.body()) as { x?: number; y?: number; double?: boolean };
        await desk.click(await this.box(comp), this.display(query), Number(body?.x) || 0, Number(body?.y) || 0, !!body?.double);
        return { ok: true };
      }
      case "type": {
        const body = (await ctx.body()) as { text?: string };
        await desk.type(await this.box(comp), this.display(query), String(body?.text ?? ""));
        return { ok: true };
      }
      case "key": {
        const body = (await ctx.body()) as { key?: string };
        await desk.key(await this.box(comp), this.display(query), String(body?.key ?? ""));
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
    this.open.set(box.id, { box: Promise.resolve(box), at: Date.now() });
    try {
      await desk.ready(box, c.vncPassword);
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
    const display = desk.displayOf(screenId);
    if (display === null) return null;
    const box = await this.box(c);
    return box.portUrl(5981 + display).replace(/^http/, "ws");
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
