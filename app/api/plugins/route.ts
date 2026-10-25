import { notReady } from "@/lib/server/ready";
import { listPlugins, removePlugin, setPluginEnabled } from "@/lib/server/skill-library";

export const dynamic = "force-dynamic";

const failed = (e: unknown) => Response.json({ error: (e as Error)?.message || "That didn't work. Try again." }, { status: 400 });

/**
 * The user's plugins (lib/server/skill-library.ts): GET lists them; POST { action: "toggle", name,
 * enabled } or { action: "remove", name }. Uploading one goes through /api/skills (a .zip with a plugin).
 */
export async function GET() {
  const unready = notReady();
  if (unready) return unready;
  try {
    return Response.json({ plugins: listPlugins() });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { action?: string; name?: string; enabled?: boolean };
  const name = typeof b.name === "string" ? b.name : "";
  try {
    if (b.action === "toggle") setPluginEnabled(name, !!b.enabled);
    else if (b.action === "remove") removePlugin(name);
    else return failed(new Error("What should happen?"));
    return Response.json({ ok: true, plugins: listPlugins() });
  } catch (e) {
    return failed(e);
  }
}
