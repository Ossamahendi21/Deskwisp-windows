import { CommandExitError, Sandbox, SandboxNotFoundError, type SandboxOpts } from "e2b";
import { BoxGone, type Box, type BoxState, type Provider } from "./types.ts";

/**
 * Boxes on E2B (e2b.dev): one sandbox per computer, from the Deskwisp template (dcloud/template).
 * A sandbox pauses on its own when nobody has used it for a while (lifecycle onTimeout: pause) and
 * comes back on the next use, with its memory, so it costs nothing while it sleeps. E2B bills by the
 * second while it runs.
 */
export class E2BProvider implements Provider {
  readonly name = "e2b";
  private readonly apiKey: string;
  private readonly template: string;
  private readonly idleMs: number;
  /** When each box last had its timer pushed back, so a busy box isn't told every request. */
  private readonly pushed = new Map<string, number>();

  constructor(opts: { apiKey: string; template: string; idleMs: number }) {
    this.apiKey = opts.apiKey;
    this.template = opts.template;
    this.idleMs = opts.idleMs;
  }

  private wrap(sb: Sandbox): Box {
    return {
      id: sb.sandboxId,
      exec: async (command, timeoutSec) => {
        try {
          const r = await sb.commands.run(`${command} 2>&1`, { timeoutMs: timeoutSec * 1000, user: "root" });
          return { output: r.stdout + r.stderr, exitCode: r.exitCode };
        } catch (e) {
          if (e instanceof CommandExitError) return { output: e.stdout + e.stderr, exitCode: e.exitCode };
          throw e;
        }
      },
      readFile: async (path) => (await sb.files.read(path, { format: "bytes", user: "root" })) as Uint8Array,
      portUrl: (port) => `https://${sb.getHost(port)}`,
    };
  }

  async create(opts: { cpu: number; ramGb: number; meta: Record<string, string> }) {
    const options: SandboxOpts = {
      apiKey: this.apiKey,
      metadata: opts.meta,
      timeoutMs: this.idleMs,
      lifecycle: { onTimeout: "pause", autoResume: true },
    };
    const sb = await Sandbox.create(this.template, options);
    this.pushed.set(sb.sandboxId, Date.now());
    return this.wrap(sb);
  }

  async open(id: string) {
    try {
      // Connecting resumes a paused sandbox.
      const sb = await Sandbox.connect(id, { apiKey: this.apiKey, timeoutMs: this.idleMs });
      return this.wrap(sb);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) throw new BoxGone(id);
      throw e;
    }
  }

  async state(id: string): Promise<BoxState> {
    try {
      const info = await Sandbox.getInfo(id, { apiKey: this.apiKey });
      return info.state === "paused" ? "paused" : "running";
    } catch (e) {
      if (e instanceof SandboxNotFoundError) return "gone";
      throw e;
    }
  }

  async pause(id: string) {
    await Sandbox.pause(id, { apiKey: this.apiKey }).catch((e) => {
      if (!(e instanceof SandboxNotFoundError)) throw e;
    });
  }

  async kill(id: string) {
    this.pushed.delete(id);
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }

  async keepAwake(id: string, ms: number) {
    const last = this.pushed.get(id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.pushed.set(id, Date.now());
    await Sandbox.setTimeout(id, ms, { apiKey: this.apiKey }).catch(() => {});
  }
}
