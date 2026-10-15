import "server-only";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { signedInUser } from "./horafirm-auth";
import { userDeskwispHome } from "./user-paths";

/**
 * Full access for bots on this PC (Settings, This PC; executorCommand in local.ts): this PC's and
 * the signed-in user's alone, so it's kept in a file of theirs here (~/.deskwisp/users/<id>, beside their
 * bots' workspace: not their state, which lives in Deskwisp Cloud). It's never part of their state in
 * Deskwisp Cloud (state-merge.ts leaves it out both ways), so nothing there can turn it on, and only the
 * Deskwisp window may (the /api/mac route asks for its token, ui-token.ts).
 */
const file = () => join(/*turbopackIgnore: true*/ userDeskwispHome(signedInUser()?.id ?? null), "full-access");

export const fullAccessOn = () => existsSync(/*turbopackIgnore: true*/ file());

export function setFullAccess(on: boolean) {
  const f = file();
  if (!on) return rmSync(/*turbopackIgnore: true*/ f, { force: true });
  mkdirSync(/*turbopackIgnore: true*/ dirname(f), { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ f, "on\n", { mode: 0o600 });
}
