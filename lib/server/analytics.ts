import "server-only";
import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import { cleanNodeEvent, POSTHOG_HOST, POSTHOG_PROJECT, quietFetch, type DeskwispEventProps, type DeskwispPersonProps, type EventsBy } from "@/cloud/analytics-rules";
import type { AnalyticsInfo } from "@/lib/analytics";
import { appVersion, telemetryHere } from "./app-version";
import { cloudOn, cloudSessionNow } from "./cloud";
import { cloudUrl } from "./cloud-url";
import { horafirmOrigin } from "./horafirm-auth";
import { onExit } from "./persist";
import { getState } from "./store";

/**
 * The PC's usage events (README, Privacy): horafirm-web's lib/analytics-server.ts for Deskwisp, through
 * posthog-node to the same project, with the Horafirm user id as the person. Only what's listed in
 * cloud/analytics-rules.ts leaves, cleaned there; never content. Nothing is sent unless this PC may
 * (telemetryHere), the app is signed in with Horafirm and on Deskwisp Cloud, and the user's switch is on.
 */

type Client = Pick<PostHog, "capture" | "captureException" | "flush" | "shutdown">;
const g = globalThis as unknown as { deskwispPosthog?: Client };

/** Whether the PC sends usage events now: never while Deskwisp has no analytics project of its own (POSTHOG_PROJECT). */
export const analyticsOn = () => !!POSTHOG_PROJECT && telemetryHere() && cloudOn() && !!getState().account && !getState().analyticsOff;

/** Which Deskwisp this is, with horafirm-web's values for its `environment` property. */
export function telemetryEnvironment(): "production" | "staging" | "development" {
  if (process.env.NODE_ENV !== "production") return "development";
  const cloud = cloudUrl();
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(cloud)) return "development";
  return cloud === "https://cloud.deskwisp.com/api" && horafirmOrigin() === "https://app.deskwisp.com" ? "production" : "staging";
}

function client(): Client {
  if (!g.deskwispPosthog) {
    g.deskwispPosthog = new PostHog(POSTHOG_PROJECT, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0, fetch: quietFetch, before_send: (m) => cleanNodeEvent(m, "mac_server") });
    // What's queued goes out before the app quits (persist.ts gives exit work up to 5 seconds).
    onExit("posthog", () => g.deskwispPosthog!.shutdown(2000));
  }
  return g.deskwispPosthog;
}

const plan = () => cloudSessionNow()?.plan?.tier;

const superProps = () => {
  const v = appVersion();
  const p = plan();
  return { app: "deskwisp", platform: "mac", source: "mac_server", environment: telemetryEnvironment(), ...(v ? { app_version: v } : {}), ...(p ? { plan: p } : {}) };
};

/** horafirm-web's lib/funnel-capture.ts milestoneUuid, as is: the same event for the same thing counts once. */
export function milestoneUuid(event: string, userId: string, entityId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([event, userId, entityId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Send one of the PC's events for the signed-in user. `userId`: only if that's still who's signed
 * in (for work that finishes after a sign-out or a switch). `once`: counted once per this id. Never throws.
 */
export function trackServerEvent<E extends EventsBy<"mac_server">>(
  event: E,
  props: DeskwispEventProps[E],
  opts: { userId?: string; once?: string; set?: DeskwispPersonProps; setOnce?: DeskwispPersonProps } = {},
): void {
  try {
    const uid = getState().account?.user.id;
    if (!uid || (opts.userId && opts.userId !== uid) || !analyticsOn()) return;
    client().capture({
      distinctId: uid,
      event,
      ...(opts.once ? { uuid: milestoneUuid(event, uid, opts.once) } : {}),
      properties: {
        ...(props as Record<string, unknown>),
        ...superProps(),
        ...(opts.set ? { $set: opts.set } : {}),
        ...(opts.setOnce ? { $set_once: opts.setOnce } : {}),
      },
    });
  } catch {
    // Analytics never breaks what the user is doing.
  }
}

/** An unexpected error in the PC's server (instrumentation.ts): its type and where in Deskwisp's code, never its message. Never throws. */
export function captureServerException(err: unknown, routePath?: string): void {
  try {
    const uid = getState().account?.user.id;
    if (!uid || !analyticsOn()) return;
    client().captureException(err, uid, { ...superProps(), surface: "mac_server", ...(routePath ? { route_path: routePath } : {}) });
  } catch {}
}

/** GET /api/analytics. */
export function analyticsInfo(): AnalyticsInfo {
  const s = getState();
  const user = cloudOn() ? (s.account?.user ?? null) : null;
  return {
    on: analyticsOn(),
    share: !s.analyticsOff,
    locked: !telemetryHere(),
    userId: user?.id ?? null,
    internal: /@deskwisp\.com$/i.test(user?.email ?? ""),
    environment: telemetryEnvironment(),
    appVersion: appVersion() ?? null,
    plan: plan() ?? null,
  };
}

/** For tests: send what's queued now. */
export const flushAnalytics = () => g.deskwispPosthog?.flush();
