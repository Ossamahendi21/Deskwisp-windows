import { computerInUse, workBot } from "@/lib/types";
import { horafirm } from "@/lib/server/horafirm";
import { workComputer } from "@/lib/server/screens";
import { bot, getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Put a bot's computer to sleep ({ botId }): the user is done with it for now. Not while a bot works on
 * it or the user drives one of its screens (stop that first). It wakes on its own the next time it's used.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId } = (await request.json().catch(() => ({}))) as { botId?: string };
  const b = botId ? bot(botId) : undefined;
  if (!b) return Response.json({ error: "No such bot." }, { status: 404 });
  const c = workComputer(b);
  if (!c.computerId) return Response.json({ error: `${c.name} has no computer.` }, { status: 409 });
  const state = getState();
  const onIt = (id: string) => {
    const x = state.bots.find((y) => y.id === id);
    return !!x && workBot(x, state.bots).id === c.id;
  };
  if (computerInUse(state, onIt))
    return Response.json({ error: "A bot is working on this computer, or you're driving it. Stop that first." }, { status: 409 });
  try {
    await horafirm.suspend(c.computerId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
