import { APP_VERSION_HEADER, TELEMETRY_HEADER } from "@/cloud/protocol";

/**
 * This app's version: package.json's, set in the build (next.config.ts). Undefined when it isn't
 * known (a test that sets none).
 */
export const appVersion = (): string | undefined => process.env.DESKWISP_APP_VERSION || undefined;

/**
 * Whether this PC may send usage events at all (README, Privacy): a production build of the app,
 * or DESKWISP_TELEMETRY=1 on another; never self-hosted or on a hosted server (DESKWISP_DATABASE_URL), and
 * never with DESKWISP_TELEMETRY=0 or DO_NOT_TRACK=1. The account's own switch is checked on top of this.
 */
export function telemetryHere(): boolean {
  const env = process.env;
  if (env.DESKWISP_SELF_HOSTED === "1" || env.DESKWISP_DATABASE_URL || env.DESKWISP_TELEMETRY === "0" || env.DO_NOT_TRACK === "1") return false;
  return env.NODE_ENV === "production" || env.DESKWISP_TELEMETRY === "1";
}

/**
 * What tells Deskwisp Cloud which app is calling, for every call to it (cloud/app-version.ts), and, on a
 * PC that sends no usage events, that the cloud should send none for what it does either.
 */
export const appHeaders = (): Record<string, string> => {
  const v = appVersion();
  return { ...(v ? { [APP_VERSION_HEADER]: v } : {}), ...(telemetryHere() ? {} : { [TELEMETRY_HEADER]: "off" }) };
};

/**
 * What tells horafirm-web which Deskwisp app is calling, for every call to Horafirm's API: the version alone, never
 * a usage switch (an API call isn't a usage event). Horafirm takes a Deskwisp computer off its server while it
 * sleeps only when every app its owner uses waits for it to wake again rather than taking it for broken
 * (this release and later: lib/server/horafirm.ts, sessions.ts ensureComputer); an older app, or one that
 * doesn't say, keeps the user's computer where it is.
 */
export const horafirmHeaders = (): Record<string, string> => {
  const v = appVersion();
  return v ? { [APP_VERSION_HEADER]: v } : {};
};
