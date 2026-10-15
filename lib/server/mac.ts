import "server-only";
import { existsSync } from "node:fs";
import type { MacState } from "@/lib/types";
import { findCodex, installCodex, installStatus } from "./codex-cli";
import { CHROME } from "./local";
import { onPostgres } from "./persist";
import { getState, stateReady, update } from "./store";
import { ON_MAC } from "./platform";

/**
 * The user's PC as a place bots work. A task on the PC runs the way every task runs: OpenAI's Agents
 * API runs the agent on Deskwisp's API and the user's AI credit (through Deskwisp Cloud, so it's counted and
 * priced), and `codex exec-server` runs its tools here, with Deskwisp's own key (local.ts startExecutor),
 * in a Chrome of its own on this PC, so websites see the user's home internet (sessions.ts run). The
 * executor runs in a macOS sandbox that leaves it the browser tools and nothing else: no shell, no
 * other programs, none of the user's files (executor-sandbox.ts).
 *
 * Deskwisp never signs anyone in to ChatGPT and never starts Codex's app server: OpenAI doesn't allow its
 * app-server sign-in in a hosted or paid product. So bots don't use the PC's own apps (Messages,
 * Notes, Finder…) for now; a task that needs one says so. The PC is ready once the Codex CLI is here
 * (Deskwisp installs it by itself, codex-cli.ts) and Chrome is.
 */

/** Apps and words that, named in a task, mean it belongs on the user's PC (they can change the list). */
export const DEFAULT_MAC_RULES = ["Messages", "iMessage", "Notes", "Apple Mail", "Photos", "Finder", "Keynote", "Pages", "Numbers", "Xcode", "Reminders", "my desktop", "my Downloads", "my laptop", "my PC"];

export const emptyMac = (): MacState => ({ ready: false, rules: [...DEFAULT_MAC_RULES] });

/** This server runs on the user's PC (not a hosted one), where bots can work. */
const onTheMac = () => ON_MAC && !onPostgres();

/**
 * Is the user's PC ready for bots, and if not, the one thing it waits on: the Codex CLI that runs the
 * tools (Deskwisp installs it when it's missing, once per start and again on Retry), or Chrome. Checked
 * now and then; the answer lives in state.mac.
 */
export async function checkMac() {
  // This PC's readiness is kept in the signed-in user's state (state.mac, this PC's own: state.macs):
  // none to keep it in signed out. A sign-in looks again once their state has loaded (horafirm-sign-in.ts).
  if (!stateReady()) return false;
  let ready = false;
  let reason: string | undefined;
  let next: MacState["next"];
  if (!onTheMac()) {
    next = "elsewhere";
    reason = "Bots work on your PC in the Deskwisp app on your PC.";
  } else if (!findCodex()) {
    if (!installStatus()) installCodex(() => void checkMac().catch(() => {}));
    const failed = installStatus()?.state === "failed" ? installStatus()?.error : undefined;
    next = "codex";
    reason = failed !== undefined ? `Couldn't install Codex. ${failed}` : "Installing Codex";
  } else if (!existsSync(CHROME)) {
    next = "chrome";
    reason = "Install Google Chrome so bots can work on this PC";
  } else ready = true;
  const now = { ready, reason, next, installing: next === "codex" && installStatus()?.state === "installing" };
  // Only a change goes out to the app.
  const was = getState().mac;
  if (was && (Object.keys(now) as (keyof typeof now)[]).every((k) => was[k] === now[k])) return ready;
  update((state) => {
    state.mac ??= emptyMac();
    Object.assign(state.mac, { ...now, checkedAt: Date.now() });
  });
  return ready;
}

/** Retry: install the CLI again if it's still missing (a failed install isn't retried by itself), then look again. */
export async function retryCodex() {
  if (!findCodex() && onTheMac()) installCodex(() => void checkMac().catch(() => {}));
  await checkMac();
}

const g = globalThis as typeof globalThis & { __deskwispMacCheck?: ReturnType<typeof setInterval> };
g.__deskwispMacCheck ??= setInterval(() => void checkMac().catch(() => {}), 5 * 60_000);
void checkMac().catch(() => {});
