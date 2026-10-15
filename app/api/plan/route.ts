import { cloudOn } from "@/lib/server/cloud";
import { loadHorafirmKey } from "@/lib/server/horafirm-auth";
import { horafirmPages, horafirmPlan, readDeskwispPlan } from "@/lib/server/plan";
import { getState } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * The user's Horafirm plan for the app (lib/server/plan.ts): the computers it allows and how many are in
 * use, or null when Horafirm couldn't be asked. With the Horafirm pages to change it. ?fresh=1 asks Horafirm again
 * rather than answer from the last minute (the user may have just upgraded). Then, and while the AI
 * credit is out, the Deskwisp plan comes too (`deskwisp`, as GET /api/account has it): credit there ends the
 * "out of AI credit" card (the user may have just paid).
 */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const key = fresh || getState().credits?.out ? await loadHorafirmKey() : null;
  const [plan, deskwisp] = await Promise.all([horafirmPlan({ fresh }), key && cloudOn() ? readDeskwispPlan(key) : undefined]);
  return Response.json({ plan, links: horafirmPages(), ...(deskwisp !== undefined ? { deskwisp } : {}) });
}
