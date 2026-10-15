import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

/**
 * A file from vm/, as the bots' Linux computers need it: with LF line endings. A Windows checkout
 * (git's core.autocrlf) may have given it CRLF, which bash and Python's shebang line reject.
 */
export function vmFile(rel: string): Buffer {
  return Buffer.from(readFileSync(join(cwd(), "vm", rel), "utf8").replace(/\r\n/g, "\n"));
}
