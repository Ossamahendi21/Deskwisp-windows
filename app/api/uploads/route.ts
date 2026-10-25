import { saveFile, saveUpload, MAX_FILE_BYTES } from "@/lib/server/uploads";
import { notReady } from "@/lib/server/ready";

/**
 * Attach something in chat. An image comes as JSON with a data URL (already resized) and gets its id
 * back; any other file comes as a form with a `file` and gets its id, name, type and size back.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  try {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
      if (file.size > MAX_FILE_BYTES) return Response.json({ error: "That file is too big (25 MB at most)." }, { status: 400 });
      return Response.json(saveFile(file.name, file.type, Buffer.from(await file.arrayBuffer())));
    }
    const { dataUrl } = (await request.json().catch(() => ({}))) as { dataUrl?: string };
    if (!dataUrl) return Response.json({ error: "no image" }, { status: 400 });
    return Response.json(saveUpload(dataUrl));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
