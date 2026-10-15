import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BoxGone, type Box, type BoxState, type ExecResult, type Provider } from "./types.ts";

/**
 * Boxes on this machine, for development and tests: each box is a folder, and its commands run here
 * as this user with HOME set to that folder. There's no isolation, so this is never for real users.
 * Only one box should run desktop screens at a time, since displays and ports are this machine's.
 */
export class LocalProvider implements Provider {
  readonly name = "local";
  private readonly root: string;
  private readonly states = new Map<string, BoxState>();

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private box(id: string): Box {
    const home = join(this.root, id);
    return {
      id,
      exec: (command, timeoutSec) => run(command, home, timeoutSec),
      readFile: async (path) => new Uint8Array(readFileSync(path)),
      portUrl: (port) => `http://127.0.0.1:${port}`,
    };
  }

  async create(): Promise<Box> {
    const id = `local-${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.root, id), { recursive: true });
    this.states.set(id, "running");
    return this.box(id);
  }

  async open(id: string) {
    if (!this.states.has(id)) throw new BoxGone(id);
    this.states.set(id, "running");
    return this.box(id);
  }

  async state(id: string): Promise<BoxState> {
    return this.states.get(id) ?? "gone";
  }

  async pause(id: string) {
    if (this.states.has(id)) this.states.set(id, "paused");
  }

  async kill(id: string) {
    this.states.delete(id);
    rmSync(join(this.root, id), { recursive: true, force: true });
  }

  async keepAwake() {}
}

function run(command: string, home: string, timeoutSec: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-lc", command], { cwd: home, env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {}
    }, timeoutSec * 1000);
    // On the shell's exit, not its pipes closing: a daemon it started may hold them open for good.
    p.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        p.stdout.destroy();
        p.stderr.destroy();
        resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 124 });
      }, 30);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ output: e.message, exitCode: 127 });
    });
  });
}
