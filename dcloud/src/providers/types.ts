/**
 * Where a bot's computer runs. A provider only has to give a Linux box with a shell: everything a
 * desktop needs (screens, screenshots, the mouse and keyboard, live view) runs inside the box, through
 * its tools (dcloud/template), so the same API works on E2B, on your own server, or here for tests.
 */

export type ExecResult = { output: string; exitCode: number };

export interface Box {
  /** The provider's own id for the box. */
  readonly id: string;
  /** Runs a bash command as the box's user, stdout and stderr together. Never throws for a non-zero exit. */
  exec(command: string, timeoutSec: number): Promise<ExecResult>;
  /** A file's bytes, when the provider can read files directly (faster than base64 through exec). */
  readFile?(path: string): Promise<Uint8Array>;
  /** The base URL (http or https, no trailing slash) that reaches a TCP port inside the box. */
  portUrl(port: number): string;
}

export type BoxState = "running" | "paused" | "gone";

export interface Provider {
  readonly name: string;
  /** A new box from the computer template. `meta` is kept with the box where the provider can. */
  create(opts: { cpu: number; ramGb: number; meta: Record<string, string> }): Promise<Box>;
  /** The box, woken first when it was paused. Throws BoxGone when it's gone. */
  open(id: string): Promise<Box>;
  state(id: string): Promise<BoxState>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  /** Keeps a box awake for `ms` more (each use calls it); after that it pauses on its own. */
  keepAwake(id: string, ms: number): Promise<void>;
}

/** The box doesn't exist any more (killed, expired): the computer is gone. */
export class BoxGone extends Error {
  constructor(id: string) {
    super(`box ${id} is gone`);
  }
}
