import { cloudJson, cloudOn, cloudSession, CloudError } from "@/lib/server/cloud";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);

type KeyState = { connected: boolean; last4?: string; signup?: string };

/**
 * The user's own AgentPhone account for their bots' numbers (cloud/phone-key.ts): they pay AgentPhone
 * themselves, and Deskwisp uses their key. GET says whether one is connected; PUT { key } connects it
 * (AgentPhone checks it first); DELETE forgets it. After a change the session is asked for again, so
 * phones turn on or off at once (lib/server/phone.ts phoneOn).
 */
export async function GET() {
  if (!cloudOn()) return Response.json({ connected: false, available: false });
  try {
    return Response.json({ ...(await cloudJson<KeyState>("/v1/phone/key")), available: true });
  } catch (e) {
    return Response.json({ connected: false, available: false, error: (e as Error).message });
  }
}

async function change(request: Request, method: "PUT" | "DELETE") {
  const unready = notReady();
  if (unready) return unready;
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  if (!cloudOn()) return Response.json({ error: "Sign in to Deskwisp first." }, { status: 400 });
  const body = method === "PUT" ? JSON.stringify({ key: ((await request.json().catch(() => ({}))) as { key?: unknown }).key }) : undefined;
  try {
    const state = await cloudJson<KeyState>("/v1/phone/key", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}) });
    await cloudSession(true).catch(() => {});
    return Response.json(state);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof CloudError && e.status < 500 ? 400 : 502 });
  }
}

export const PUT = (request: Request) => change(request, "PUT");
export const DELETE = (request: Request) => change(request, "DELETE");
