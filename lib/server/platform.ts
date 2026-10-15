import { platform } from "node:os";

/**
 * The system this server runs on, read when it starts. Not process.platform: the build fills that in
 * with the platform of the machine that built it, so a server built on Linux for Windows would take
 * itself for Linux.
 */
export const PLATFORM = platform();
export const ON_WINDOWS = PLATFORM === "win32";
export const ON_MAC = PLATFORM === "darwin";
