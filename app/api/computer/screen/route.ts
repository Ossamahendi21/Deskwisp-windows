import { startScreen, stopScreen } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";
import { fromDeskwispWindow } from "@/lib/server/ui-token";

/**
 * Start or close one of a bot's screens (lib/server/slots.ts): {botId, n, action: "start" | "close"}.
 * Screens open on their own when a bot starts a task there; this is the user doing it from the
 * bot's computer view. Only from the Deskwisp window.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromDeskwispWindow(request)) return Response.json({ error: "Screens can only be started in the Deskwisp app." }, { status: 403 });
  const { botId, n, action } = (await request.json().catch(() => ({}))) as { botId?: string; n?: number; action?: string };
  try {
    if (action === "close") {
      await stopScreen(String(botId ?? ""), Number(n));
      return Response.json({ ok: true });
    }
    return Response.json(await startScreen(String(botId ?? ""), Number(n)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
