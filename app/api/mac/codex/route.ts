import { retryCodex } from "@/lib/server/mac";
import { findCodex, installStatus } from "@/lib/server/codex-cli";
import { fromThisMac } from "@/lib/server/owner-email";
import { getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** Codex on this PC: where it is, Deskwisp's own install of it ({ state, error?, version? }), and the PC's readiness (state.mac). */
export async function GET() {
  return Response.json({ codex: findCodex() ?? null, install: installStatus() ?? null, mac: getState().mac ?? null });
}

/** What the sign-in actions answer now: Deskwisp doesn't sign in to ChatGPT or Codex (lib/server/mac.ts). */
const SIGN_IN_GONE = "Deskwisp doesn't sign in to Codex anymore. Bots use Deskwisp AI credit for all their work, on your PC too.";

/**
 * { action: "install" } installs the Codex CLI again if it's still missing (Retry), from the app on
 * this PC only, then looks at the PC again. Deskwisp runs bots' tools with it, on its own key. Signing in
 * to Codex ("sign-in", "reopen", "cancel") and opening the Codex app ("open") are gone: 410.
 */
export async function POST(request: Request) {
  const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (action === "sign-in" || action === "reopen" || action === "cancel" || action === "open") return Response.json({ ok: false, error: SIGN_IN_GONE }, { status: 410 });
  const unready = notReady();
  if (unready) return unready;
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "This works in the Deskwisp app on your PC." }, { status: 403 });
  if (action !== "install") return Response.json({ ok: false, error: "action: install" }, { status: 400 });
  try {
    await retryCodex();
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}
