import "server-only";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, userDir } from "./store";

/**
 * Images the user attaches in chat, kept on this PC in the signed-in user's folder
 * (.data/users/<id>/uploads): another account signed in here can't open them. Messages refer to them
 * by id; the page shows them from /api/uploads/<id>, and bots see them as images (dataUrlOf).
 */
const uploadsDir = () => {
  const dir = userDir();
  return dir ? join(dir, "uploads") : null;
};
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 12 * 1024 * 1024;

/** Save an image sent as a data URL (data:image/png;base64,…). Returns its id. */
export function saveUpload(dataUrl: string) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m || !TYPES[m[1].toLowerCase()]) throw new Error("only PNG, JPEG, WebP or GIF images");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) throw new Error("that image is too big (12 MB at most)");
  const DIR = uploadsDir();
  if (!DIR) throw new Error("sign in to Deskwisp first");
  mkdirSync(DIR, { recursive: true });
  const upId = id("img");
  writeFileSync(join(/*turbopackIgnore: true*/ DIR, `${upId}.${TYPES[m[1].toLowerCase()]}`), buf);
  return { id: upId, type: m[1].toLowerCase() };
}

/** An upload's file on disk, if it exists (ids are only letters, digits and _). */
export function uploadPath(upId: string) {
  const DIR = uploadsDir();
  if (!DIR || !/^img_[a-z0-9]+$/i.test(upId)) return null;
  for (const [type, ext] of Object.entries(TYPES)) {
    const p = join(/*turbopackIgnore: true*/ DIR, `${upId}.${ext}`);
    if (existsSync(/*turbopackIgnore: true*/ p)) return { path: p, type };
  }
  return null;
}

/** An upload as a data URL, for a model to see. */
export function dataUrlOf(upId: string) {
  const f = uploadPath(upId);
  return f ? `data:${f.type};base64,${readFileSync(/*turbopackIgnore: true*/ f.path).toString("base64")}` : null;
}

/* ---------------- Files that aren't images ---------------- */

/**
 * Any other file the user attaches in chat (Add files, "/" or the + button): kept beside the images
 * as <id>.bin with <id>.json (its name, type and size). Bots read it as they can: text (a .txt, .md,
 * .csv, code…) as its words, a PDF as a PDF, anything else by its name, and a task gets the file
 * itself in its files folder (sessions.ts).
 */
export type FileInfo = { id: string; name: string; type: string; size: number };
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|log|env\.example|srt|vtt|rtf|tex|ics|vcf)$/i;
export const isTextFile = (f: { name: string; type: string }) => f.type.startsWith("text/") || /^application\/(json|xml|javascript|x-yaml|yaml|sql)/.test(f.type) || TEXT_EXT.test(f.name);

/** A file's name as it can be kept and shown: no folders, no odd characters, at most 120 long. */
export function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]+/g, "_").replace(/^\.+/, "").trim().slice(-120);
  return clean || "file";
}

export function saveFile(name: string, type: string, buf: Buffer): FileInfo {
  if (buf.length > MAX_FILE_BYTES) throw new Error("That file is too big (25 MB at most).");
  if (!buf.length) throw new Error("That file is empty.");
  const DIR = uploadsDir();
  if (!DIR) throw new Error("sign in to Deskwisp first");
  mkdirSync(DIR, { recursive: true });
  const info: FileInfo = { id: id("fil"), name: cleanName(name), type: (type || "application/octet-stream").slice(0, 100), size: buf.length };
  writeFileSync(join(/*turbopackIgnore: true*/ DIR, `${info.id}.bin`), buf);
  writeFileSync(join(/*turbopackIgnore: true*/ DIR, `${info.id}.json`), JSON.stringify(info));
  return info;
}

/** A file's details and where it is, if it's here (ids are only letters, digits and _). */
export function fileOf(fileId: string): (FileInfo & { path: string }) | null {
  const DIR = uploadsDir();
  if (!DIR || !/^fil_[a-z0-9]+$/i.test(fileId)) return null;
  const path = join(/*turbopackIgnore: true*/ DIR, `${fileId}.bin`);
  try {
    const info = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(DIR, `${fileId}.json`), "utf8")) as FileInfo;
    if (!existsSync(/*turbopackIgnore: true*/ path)) return null;
    return { ...info, id: fileId, size: statSync(/*turbopackIgnore: true*/ path).size, path };
  } catch {
    return null;
  }
}

/** How a model reads a file: its words (text up to `maxText` characters), a PDF (up to 10 MB), or only its name. */
export function fileForModel(fileId: string, maxText = 60_000): { kind: "text"; text: string; cut: boolean } | { kind: "pdf"; dataUrl: string; name: string } | null {
  const f = fileOf(fileId);
  if (!f) return null;
  if (isTextFile(f) && f.size <= 2 * 1024 * 1024) {
    const all = readFileSync(/*turbopackIgnore: true*/ f.path, "utf8");
    return { kind: "text", text: all.slice(0, maxText), cut: all.length > maxText };
  }
  if ((f.type === "application/pdf" || /\.pdf$/i.test(f.name)) && f.size <= 10 * 1024 * 1024)
    return { kind: "pdf", name: f.name, dataUrl: `data:application/pdf;base64,${readFileSync(/*turbopackIgnore: true*/ f.path).toString("base64")}` };
  return null;
}

/** "34 KB", "2.1 MB". */
export const sizeWords = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

