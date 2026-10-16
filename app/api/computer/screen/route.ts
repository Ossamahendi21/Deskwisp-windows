import { continueOnScreen, startScreen, startScreenTask, stopScreen } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";
import { fromDeskwispWindow } from "@/lib/server/ui-token";

/**
 * One of a bot's screens (lib/server/slots.ts), from its computer view. {botId, n, action}:
 * - "start": open it, for the user to use.
 * - "close": close it now (it closes by itself two minutes after nothing's going on there).
 * - "continue": the thread that ran there last carries on there.
 * - "task" with {goal}: a new thread there.
 * Screens also open on their own when a bot starts a task. Only from the Deskwisp window.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromDeskwispWindow(request)) return Response.json({ error: "Screens can only be used in the Deskwisp app." }, { status: 403 });
  const { botId, n, action, goal } = (await request.json().catch(() => ({}))) as { botId?: string; n?: number; action?: string; goal?: string };
  const who = String(botId ?? "");
  const which = Number(n);
  try {
    if (action === "close") {
      await stopScreen(who, which);
      return Response.json({ ok: true });
    }
    if (action === "continue") {
      const r = continueOnScreen(who, which);
      return r ? Response.json(r) : Response.json({ error: "Nothing ran on this screen yet" }, { status: 404 });
    }
    if (action === "task") return Response.json(startScreenTask(who, which, String(goal ?? "")));
    return Response.json(await startScreen(who, which));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
