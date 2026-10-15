import { fromThisMac } from "@/lib/server/owner-email";
import { prepareRestart } from "@/lib/server/restart";

export const dynamic = "force-dynamic";

/**
 * Restart Deskwisp, from the PC app only (desktop/main.cjs asks it): the state is saved (the signed-in
 * user's, to Deskwisp Cloud), cached sessions go (lib/server/restart.ts). It answers with this server's
 * process, which the PC app then stops before it opens again, also when something here went wrong
 * (ok: false, with what, such as changes that hadn't reached Deskwisp Cloud yet): a restart is what fixes
 * a stuck server.
 */
export async function POST(request: Request) {
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "This works in the Deskwisp app on your PC." }, { status: 403 });
  const error = await prepareRestart().then(
    () => undefined,
    (e: Error) => e.message,
  );
  if (error) console.warn(`[restart] ${error}`);
  return Response.json({ ok: !error, error, pid: process.pid });
}
