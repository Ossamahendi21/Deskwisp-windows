import { catalog, composioOn } from "@/lib/server/composio";
import { cloudOn } from "@/lib/server/cloud";

/** Every app the user can connect (Composio's catalog), most used first, for the app picker. */
export async function GET() {
  // Self-hosted without a Composio key: say what's missing, rather than an empty picker.
  if (!composioOn())
    return Response.json(
      { apps: [], off: true, error: cloudOn() ? "Connected apps aren't available right now." : "Connected apps need a Composio key: add COMPOSIO_API_KEY to .env.local, then restart Deskwisp." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  try {
    return Response.json({ apps: await catalog() }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    return Response.json({ apps: [], error: (e as Error).message }, { status: 502 });
  }
}
