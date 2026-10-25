import { readFileSync } from "node:fs";
import { fileOf, uploadPath } from "@/lib/server/uploads";

/**
 * An attached image (it never changes, so the page can keep it cached), or an attached file: it
 * downloads under its own name (never shown in the app's page: a file someone sent could be a web page).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const f = uploadPath(uploadId);
  if (f) return new Response(readFileSync(f.path), { headers: { "Content-Type": f.type, "Cache-Control": "private, max-age=31536000, immutable" } });
  const file = fileOf(uploadId);
  if (!file) return new Response("not found", { status: 404 });
  return new Response(readFileSync(file.path), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
