import { notReady } from "@/lib/server/ready";
import { createSkill, getSkill, listSkills, MAX_UPLOAD_BYTES, removeSkill, saveSkill, setSkillEnabled, slashMenu, uploadFile } from "@/lib/server/skill-library";

export const dynamic = "force-dynamic";

const failed = (e: unknown, status = 400) => Response.json({ error: (e as Error)?.message || "That didn't work. Try again." }, { status });

/**
 * The user's skills (lib/server/skill-library.ts). GET lists them; ?id= gives one in full; ?menu=1
 * gives what "/" in a chat lists (skills and plugin commands that are on). POST { action }: create
 * { name, description, body }, save { id, description, body }, toggle { id, enabled }, remove { id };
 * or a form with a `file` (a SKILL.md, or a .zip of skills or of a plugin) to upload it.
 */
export async function GET(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const q = new URL(request.url).searchParams;
  try {
    if (q.get("menu")) return Response.json(slashMenu());
    const id = q.get("id");
    if (id) {
      const s = getSkill(id);
      return s ? Response.json({ skill: s }) : Response.json({ error: "That skill isn't here anymore." }, { status: 404 });
    }
    return Response.json({ skills: listSkills() });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  try {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return failed(new Error("Choose a file."));
      if (file.size > MAX_UPLOAD_BYTES) return failed(new Error("That file is too big (30 MB at most)."));
      const added = uploadFile(file.name, Buffer.from(await file.arrayBuffer()));
      return Response.json({ ok: true, ...added, skills: listSkills(), addedSkills: added.skills });
    }
    const b = (await request.json().catch(() => ({}))) as { action?: string; id?: string; name?: string; description?: string; body?: string; enabled?: boolean };
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    if (b.action === "create") {
      const id = createSkill(str(b.name), str(b.description), str(b.body));
      return Response.json({ ok: true, id, skills: listSkills() });
    }
    if (b.action === "save") saveSkill(str(b.id), str(b.description), str(b.body));
    else if (b.action === "toggle") setSkillEnabled(str(b.id), !!b.enabled);
    else if (b.action === "remove") removeSkill(str(b.id));
    else return failed(new Error("What should happen?"));
    return Response.json({ ok: true, skills: listSkills() });
  } catch (e) {
    return failed(e);
  }
}
