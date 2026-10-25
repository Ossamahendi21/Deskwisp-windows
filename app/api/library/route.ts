import { notReady } from "@/lib/server/ready";
import { addFromLibrary, addLibrary, addPluginFromLibrary, catalog, removeLibrary } from "@/lib/server/skill-catalog";
import { listPlugins, listSkills } from "@/lib/server/skill-library";

export const dynamic = "force-dynamic";

const failed = (e: unknown) => Response.json({ error: (e as Error)?.message || "That didn't work. Try again." }, { status: 400 });

/**
 * Discover (lib/server/skill-catalog.ts): GET the libraries on GitHub and what's in them (?refresh=1
 * reads them again now). POST { action }: "add-skill" { library, folder }, "add-plugin" { library,
 * folder }, "add-library" { url } (a GitHub repository or a folder in one), "remove-library" { id }.
 */
export async function GET(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  try {
    return Response.json(await catalog({ refresh: !!new URL(request.url).searchParams.get("refresh") }));
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { action?: string; library?: string; folder?: string; url?: string; id?: string };
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  try {
    if (b.action === "add-skill") {
      const id = await addFromLibrary(str(b.library), str(b.folder));
      return Response.json({ ok: true, id, skills: listSkills() });
    }
    if (b.action === "add-plugin") {
      const name = await addPluginFromLibrary(str(b.library), str(b.folder));
      return Response.json({ ok: true, name, plugins: listPlugins() });
    }
    if (b.action === "add-library") {
      const l = await addLibrary(str(b.url));
      return Response.json({ ok: true, library: l, ...(await catalog()) });
    }
    if (b.action === "remove-library") {
      removeLibrary(str(b.id));
      return Response.json({ ok: true, ...(await catalog()) });
    }
    return failed(new Error("What should happen?"));
  } catch (e) {
    return failed(e);
  }
}
