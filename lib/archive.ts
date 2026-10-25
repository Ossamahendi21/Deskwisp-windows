import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * Reading the two kinds of archive skills and plugins come in: a .tar.gz (what GitHub gives for a
 * repository, lib/server/skill-catalog.ts) and a .zip (what people upload, lib/server/skill-library.ts).
 * Only regular files come out, each with a clean relative path ("a/b/c.md": no "..", no leading "/",
 * no drive letter, forward slashes), and never more than the limits say: an archive is someone else's
 * file, and a small one can unpack into gigabytes.
 */

export type ArchiveFile = { path: string; data: Buffer };
export type Limits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export const DEFAULT_LIMITS: Limits = { maxFiles: 4000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 80 * 1024 * 1024 };

/** A path inside an archive as a safe relative one, or null (one that climbs out, or is empty). */
export function cleanPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.includes("\0") || /^[a-zA-Z]:$/.test(p))) return null;
  return parts.join("/");
}

/** What a too-big file or archive does: skipped (`skip`) or the whole archive refused (an error). */
class TooBig extends Error {}

function keep(out: ArchiveFile[], total: { bytes: number }, path: string | null, size: number, read: () => Buffer, limits: Limits) {
  if (!path) return;
  // A file over its own limit is left out (a big picture in a repository); too much in all stops.
  if (size > limits.maxFileBytes) return;
  if (out.length >= limits.maxFiles) throw new TooBig(`more than ${limits.maxFiles} files`);
  total.bytes += size;
  if (total.bytes > limits.maxTotalBytes) throw new TooBig(`more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`);
  out.push({ path, data: read() });
}

/** The files in a .tar.gz (or a plain .tar). Long names (pax "path", GNU "L") are understood. */
export function readTarGz(buf: Buffer, limits: Limits = DEFAULT_LIMITS): ArchiveFile[] {
  const tar = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: limits.maxTotalBytes * 2 + 1024 * 1024 }) : buf;
  const out: ArchiveFile[] = [];
  const total = { bytes: 0 };
  let off = 0;
  let longName: string | null = null;
  const str = (b: Buffer) => {
    const z = b.indexOf(0);
    return (z < 0 ? b : b.subarray(0, z)).toString("utf8");
  };
  const num = (b: Buffer) => {
    // Base-256 for big sizes (first byte 0x80), else octal.
    if (b[0] & 0x80) return b.subarray(1).reduce((n, x) => n * 256 + x, 0);
    return parseInt(str(b).trim() || "0", 8);
  };
  try {
    while (off + 512 <= tar.length) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const size = num(h.subarray(124, 136));
      const type = String.fromCharCode(h[156] || 0x30);
      const prefix = str(h.subarray(345, 500));
      const name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
      const start = off + 512;
      const body = () => Buffer.from(tar.subarray(start, start + size));
      off = start + Math.ceil(size / 512) * 512;
      if (type === "x") {
        // pax: "len path=value\n" records; only the path matters here.
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body().toString("utf8"));
        longName = m ? m[1] : null;
        continue;
      }
      if (type === "L") {
        longName = body().toString("utf8").replace(/\0+$/, "");
        continue;
      }
      longName = null;
      if (type === "0" || type === "\0" || type === "7") keep(out, total, cleanPath(name), size, body, limits);
    }
  } catch (e) {
    if (e instanceof TooBig) throw new Error(`That archive is too big (${e.message}).`);
    throw e;
  }
  return out;
}

/** The files in a .zip (stored or deflated; others are left out). Read from its central directory. */
export function readZip(buf: Buffer, limits: Limits = DEFAULT_LIMITS): ArchiveFile[] {
  // The end of central directory record: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("That isn't a zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ArchiveFile[] = [];
  const total = { bytes: 0 };
  try {
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("That zip file is damaged.");
      const method = buf.readUInt16LE(p + 10);
      const packed = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const attrs = buf.readUInt32LE(p + 38);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;
      // Folders, and links (a Unix symlink's mode in the high bits) aren't files.
      const unixMode = attrs >>> 16;
      if (name.endsWith("/") || (unixMode & 0o170000) === 0o120000) continue;
      if (method !== 0 && method !== 8) continue;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("That zip file is damaged.");
      const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      keep(
        out,
        total,
        cleanPath(name),
        size,
        () => {
          const raw = buf.subarray(dataAt, dataAt + packed);
          const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes + 1 });
          if (data.length !== size) throw new Error("That zip file is damaged.");
          return data;
        },
        limits,
      );
    }
  } catch (e) {
    if (e instanceof TooBig) throw new Error(`That archive is too big (${e.message}).`);
    throw e;
  }
  return out;
}

/** The files of an archive, whichever kind it is (by its first bytes). */
export function readArchive(buf: Buffer, limits: Limits = DEFAULT_LIMITS): ArchiveFile[] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readZip(buf, limits);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return readTarGz(buf, limits);
  if (buf.length >= 22 && buf.readUInt32LE(buf.length - 22) === 0x06054b50) return readZip(buf, limits);
  throw new Error("That isn't a .zip or .tar.gz file.");
}
