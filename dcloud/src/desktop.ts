import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Box } from "./providers/types.ts";

/**
 * A computer's desktop, through its shell: the screens script (dcloud/template/deskwisp-display, pushed
 * into the box on first use) and xdotool. Screens are X displays: 99 is the boot screen ("default"),
 * 100-102 are the others ("screen-100"...), as the app names them (lib/server/horafirm.ts screenId).
 */

// Without "\r": a Windows checkout may have given the script CRLF endings, which bash rejects.
const SCRIPT = Buffer.from(readFileSync(new URL("../template/deskwisp-display", import.meta.url), "utf8").replace(/\r\n/g, "\n"));
const SCRIPT_HASH = (() => {
  let h = 0;
  for (const b of SCRIPT) h = (h * 31 + b) >>> 0;
  return h.toString(16);
})();
/** Every command runs with the pushed tools first on PATH. */
const PRELUDE = 'export PATH="$HOME/.deskwisp/bin:$PATH";';
export const DISPLAYS = [99, 100, 101, 102] as const;
export const SCREEN = { width: 1280, height: 960 };

export const screenIdOf = (display: number) => (display === 99 ? "default" : `screen-${display}`);
export function displayOf(screenId: string | null | undefined): number | null {
  if (!screenId || screenId === "default") return 99;
  const m = /^screen-(\d+)$/.exec(screenId);
  const n = m ? Number(m[1]) : NaN;
  return (DISPLAYS as readonly number[]).includes(n) ? n : null;
}

/** Single quotes for bash. */
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function run(box: Box, command: string, timeoutSec = 60) {
  return box.exec(`${PRELUDE} ${command}`, timeoutSec);
}

/**
 * Puts this version of the screens script in the box, and the boot screen up with the computer's VNC
 * passwords: the full one, and the one that only lets someone watch (People with View only).
 */
export async function ready(box: Box, vncPassword: string, viewPassword: string) {
  const install =
    `mkdir -p "$HOME/.deskwisp/bin" && ` +
    `if [ "$(cat "$HOME/.deskwisp/bin/.display-version" 2>/dev/null)" != "${SCRIPT_HASH}" ]; then ` +
    `echo ${SCRIPT.toString("base64")} | base64 -d > "$HOME/.deskwisp/bin/deskwisp-display" && chmod 755 "$HOME/.deskwisp/bin/deskwisp-display" && echo ${SCRIPT_HASH} > "$HOME/.deskwisp/bin/.display-version"; fi`;
  const r = await run(box, `${install} && deskwisp-display boot ${sh(vncPassword)} ${SCREEN.width}x${SCREEN.height} ${sh(viewPassword)}`, 90);
  if (r.exitCode !== 0) throw new Error(`the computer's screens didn't start: ${r.output.trim().slice(-300)}`);
}

export type Screen = { display: number; width: number; height: number };

export async function screens(box: Box): Promise<Screen[]> {
  const r = await run(box, "deskwisp-display list", 20);
  try {
    const list = JSON.parse(r.output.trim().split("\n").pop() ?? "[]") as Screen[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** A screen started: the display asked for (when it's one and not up yet), else the next not running. Null when all four are up. */
export async function addScreen(box: Box, width = SCREEN.width, height = SCREEN.height, want?: number): Promise<Screen | null> {
  const up = new Set((await screens(box)).map((s) => s.display));
  const asked = want !== undefined && (DISPLAYS as readonly number[]).includes(want) && !up.has(want) ? want : undefined;
  const n = asked ?? DISPLAYS.find((d) => !up.has(d));
  if (n === undefined) return null;
  const r = await run(box, `deskwisp-display up ${n} ${width}x${height}`, 60);
  if (r.exitCode !== 0) throw new Error(`screen :${n} didn't start: ${r.output.trim().slice(-200)}`);
  return { display: n, width, height };
}

export async function removeScreen(box: Box, display: number) {
  await run(box, `deskwisp-display down ${display}`, 20);
}

export async function screenshot(box: Box, display: number, scale: number, format: "png" | "jpeg"): Promise<Uint8Array> {
  const s = Math.min(Math.max(Number.isFinite(scale) ? scale : 1, 0.1), 1);
  const out = `/tmp/deskwisp-shot-${randomBytes(4).toString("hex")}.${format === "png" ? "png" : "jpg"}`;
  if (box.readFile) {
    const r = await run(box, `deskwisp-display shot ${display} ${s} ${format} ${out}`, 30);
    if (r.exitCode !== 0) throw new Error(r.output.trim() || "no screenshot");
    try {
      return await box.readFile(out);
    } finally {
      void run(box, `rm -f ${out}`, 10).catch(() => {});
    }
  }
  const r = await run(box, `deskwisp-display shot ${display} ${s} ${format} ${out} >/dev/null && base64 -w0 ${out}; rm -f ${out}`, 30);
  if (r.exitCode !== 0) throw new Error(r.output.trim() || "no screenshot");
  return new Uint8Array(Buffer.from(r.output.trim(), "base64"));
}

const x = (display: number, args: string) => `DISPLAY=:${display} xdotool ${args}`;

export async function click(box: Box, display: number, px: number, py: number, double: boolean) {
  const r = await run(box, x(display, `mousemove ${Math.round(px)} ${Math.round(py)} click ${double ? "--repeat 2 --delay 80 " : ""}1`), 15);
  if (r.exitCode !== 0) throw new Error(r.output.trim());
}

export async function type(box: Box, display: number, text: string) {
  const r = await run(box, x(display, `type --delay 8 -- ${sh(text)}`), 60);
  if (r.exitCode !== 0) throw new Error(r.output.trim());
}

/** A key or a combination in xdotool's names ("Return", "ctrl+c"). */
export async function key(box: Box, display: number, name: string) {
  if (!/^[A-Za-z0-9_+\-]{1,40}$/.test(name)) throw new Error("that isn't a key");
  const r = await run(box, x(display, `key -- ${name}`), 15);
  if (r.exitCode !== 0) throw new Error(r.output.trim());
}
