import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { horafirmHeaders } from "./app-version";
import { loadHorafirmKey, horafirmOrigin } from "./horafirm-auth";
import { RTC_SHRUNK_MS } from "@/lib/rtc";
import { recordUsage } from "./usage";
import { stateEpoch } from "./store";

/** Thin Horafirm REST client (the published SDKs predate screens and clone). */

const base = () => `${horafirmOrigin()}/api`;

/**
 * The key Horafirm calls run on: the signed-in user's (Sign in with Horafirm, kept in the Keychain), else
 * HORAFIRM_API_KEY (self-hosting), else the Horafirm CLI's login in ~/.horafirm/credentials.json.
 */
async function apiKey(): Promise<string> {
  const signedIn = await loadHorafirmKey();
  if (signedIn) return signedIn;
  if (process.env.HORAFIRM_API_KEY) return process.env.HORAFIRM_API_KEY;
  try {
    const creds = JSON.parse(readFileSync(`${homedir()}/.horafirm/credentials.json`, "utf8"));
    const key = creds.profiles[creds.current ?? "default"].apiKey;
    if (key) return key;
  } catch {
    /* no CLI login either */
  }
  throw new Error("Not signed in to Horafirm");
}

/** Horafirm turned a call down: its HTTP status, its code when it sent one (VM_SLOT_ADDON, NOT_FORKABLE…), and its own words. */
export class HorafirmError extends Error {
  status: number;
  code?: string;
  said?: string;
  constructor(message: string, status: number, code?: string, said?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.said = said;
  }
}

/**
 * What Horafirm answers while a computer is still there but can't take an action yet (horafirm-web
 * lib/computer-asleep.ts and lib/with-auto-resume.ts): it's waking from storage (409 computer_waking),
 * its memory is being saved or coming back (409 suspend_in_progress, 409 resume_in_progress, 503
 * resuming), or this wake didn't work and Horafirm tries again (503 wake_failed, no_capacity,
 * saved_state_unavailable). Horafirm did nothing with the call, so an action is made again when Horafirm says
 * (Retry-After), for up to wakeWaitMs: a wake from storage in another city takes a few minutes. None of
 * them means the computer is gone (only 403 and 404 do: healIfGone in sessions.ts), and nothing deletes
 * a computer for one.
 */
export const WAKE_CODES: ReadonlySet<string> = new Set([
  "computer_waking",
  "suspend_in_progress",
  "resume_in_progress",
  "resuming",
  "wake_failed",
  "no_capacity",
  "saved_state_unavailable",
]);

/** Whether Horafirm said the computer is waking, or will be (WAKE_CODES): wait for it, never take it for gone. */
export const computerWakingError = (e: unknown) => e instanceof HorafirmError && !!e.code && WAKE_CODES.has(e.code);

/** How long an action waits on a computer that's waking: 6 minutes, or DESKWISP_WAKE_WAIT_MS. */
export const wakeWaitMs = () => {
  const n = Number(process.env.DESKWISP_WAKE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 6 * 60_000;
};

/** When Horafirm says to ask again (its Retry-After, or retry_after in the answer), between 1 second and a minute; 15 seconds when it doesn't say. */
function retryAfterMs(res: Response, json: { retry_after?: unknown }) {
  const said = Number(res.headers.get("retry-after") ?? json.retry_after);
  return Math.min(Math.max(Number.isFinite(said) && said > 0 ? said * 1000 : 15_000, 1000), 60_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to Horafirm's API, saying which Deskwisp it is (horafirmHeaders). `wait`: an action on a computer that's
 * waking (WAKE_CODES) is made again once it can be, for up to wakeWaitMs; on by default for POST and
 * PATCH, off for a read and a delete. A read of a computer that's asleep answers 409 computer_asleep at
 * once, for the caller to wake it with an action (computerAsleepError); a delete is the user's, and
 * answers at once with Horafirm's words.
 */
async function call<T>(method: string, path: string, body?: unknown, { wait = method === "POST" || method === "PATCH" }: { wait?: boolean } = {}): Promise<T> {
  const until = Date.now() + wakeWaitMs();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...horafirmHeaders(), Authorization: `Bearer ${await apiKey()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    let json: { error?: string; code?: unknown; retry_after?: unknown } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new Error(`Horafirm ${method} ${path} sent back something that isn't JSON`);
    }
    const code = typeof json.code === "string" ? json.code : undefined;
    // Still there, not ready for it yet: the same action again when Horafirm says, while there's time.
    if (!res.ok && wait && code && WAKE_CODES.has(code)) {
      const ms = retryAfterMs(res, json);
      if (Date.now() + ms <= until) {
        await sleep(ms);
        continue;
      }
    }
    // Horafirm has the odd momentary 5xx; reads are safe to try again.
    else if (res.status >= 500 && method === "GET" && attempt < 2) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok)
      throw new HorafirmError(
        `Horafirm ${method} ${path} → ${res.status}: ${json.error ?? text.slice(0, 200)}`,
        res.status,
        code,
        typeof json.error === "string" ? json.error : undefined,
      );
    return json as T;
  }
}

/**
 * One call to Horafirm with `key`, the key passed in and only that (never apiKey's fallbacks): its status and
 * JSON (an empty object when it had none), or null when it didn't answer within `timeoutMs`. `headers` go
 * along (an Idempotency-Key), never in place of the key. `path` starts with /api.
 */
export async function callHorafirm<T>(
  key: string,
  path: string,
  { method = "GET", body, headers, timeoutMs = 15_000 }: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; json: T } | null> {
  try {
    const res = await fetch(`${horafirmOrigin()}${path}`, {
      method,
      headers: { ...horafirmHeaders(), ...headers, Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
  } catch {
    return null;
  }
}

const lanes = new Map<string, Promise<unknown>>();
/** Run calls for one computer one at a time. */
function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  lanes.set(key, next);
  return next;
}

/** A screen as Horafirm lists it. `vnc_port`/`ws_port`: null in a list horafirm-web answered from its record (a computer asleep). */
export type HorafirmScreen = { id: string; display: string; width: number; height: number; default: boolean; vnc_port?: number | null; ws_port?: number | null };

export type HorafirmComputer = { id: string; name: string; status: string; cpu: number; ram: number; os: string };

/**
 * Deskwisp computers live in their own Horafirm workspace; nothing outside it is ever created or deleted
 * here. It's the signed-in user's own workspace named "deskwisp" (any case, so an older "Deskwisp" is kept),
 * made the first time. DESKWISP_HORAFIRM_WORKSPACE pins one instead, but only without a signed-in user: a
 * pinned id belongs to the self-hoster's key, not to whoever signs in.
 *
 * The id is cached per server process; signIn() and signOut() clear the cache (horafirm-auth.ts), so
 * the next user never lands in the last one's workspace.
 */
const WORKSPACE = "deskwisp";
type HorafirmWorkspace = { id: string; name: string; role?: string };
const g = globalThis as unknown as { deskwispHorafirmWorkspace?: Promise<string>; deskwispComputerChanges?: number; deskwispMadeHere?: Set<string> };

/**
 * How many computers Deskwisp has made or deleted since the server started. What's known about the plan's
 * computers in use (lib/server/plan.ts) is read again after a change.
 */
export const computerChanges = () => g.deskwispComputerChanges ?? 0;
const changed = () => void (g.deskwispComputerChanges = computerChanges() + 1);

/**
 * The computers this server made (a create, a fork or a clone) and hasn't had ready yet, by id. Only
 * such a computer may be deleted by a setup that fails (ensureComputer in sessions.ts, which keeps the
 * mark on the bot as computerNeverReady): one Deskwisp didn't make (the user's free computer taken up again,
 * one from another Mac) or once had working is never deleted for a failed setup, whatever Horafirm says.
 */
const madeHere = (g.deskwispMadeHere ??= new Set());
/** Whether this server made the computer and hasn't had it ready since (madeReady). */
export const madeByThisServer = (computerId: string) => madeHere.has(computerId);
/** The computer is ready: from now on it may hold the user's work, so it's no longer one Deskwisp just made. */
export const madeReady = (computerId: string) => void madeHere.delete(computerId);
const made = <C extends { id: string }>(c: C) => (madeHere.add(c.id), c);

/** The workspaces the user owns. GET /api/workspaces lists shared ones too (role "member" and up). */
const ownedWorkspaces = async () => ((await call<{ workspaces?: HorafirmWorkspace[] }>("GET", "/workspaces")).workspaces ?? []).filter((w) => (w.role ?? "owner") === "owner");
const isDeskwisp = (w: HorafirmWorkspace) => w.name.trim().toLowerCase() === WORKSPACE;

export async function deskwispWorkspace(): Promise<string> {
  if (process.env.DESKWISP_HORAFIRM_WORKSPACE && !(await loadHorafirmKey())) return process.env.DESKWISP_HORAFIRM_WORKSPACE;
  return (g.deskwispHorafirmWorkspace ??= (async () => {
    // Only one the user owns will do.
    const find = async () => (await ownedWorkspaces()).find(isDeskwisp)?.id;
    const found = await find();
    if (found) return found;
    try {
      return (await call<{ id: string }>("POST", "/workspaces", { name: WORKSPACE })).id;
    } catch (e) {
      // Horafirm refuses a second workspace with the same name (any case): someone else just made it.
      const made = await find();
      if (made) return made;
      throw e;
    }
  })().catch((e: Error) => {
    g.deskwispHorafirmWorkspace = undefined;
    throw e;
  }));
}

/**
 * A workspace the user owns, to read their plan's numbers by (Horafirm counts computers against the owner,
 * across every workspace they own): the "deskwisp" one when there is one, else any. Unlike deskwispWorkspace it
 * never makes one, so reading the plan leaves nothing behind in an account that never used the cloud.
 * Null when they own none.
 */
export async function ownedWorkspace(): Promise<string | null> {
  const deskwisp = await g.deskwispHorafirmWorkspace?.catch(() => undefined);
  if (deskwisp) return deskwisp;
  const owned = await ownedWorkspaces();
  return (owned.find(isDeskwisp) ?? owned[0])?.id ?? null;
}

/**
 * The user's own "deskwisp" workspace as the People sheet finds it: its id (with how many have access, the
 * user included, when Horafirm said), none yet, or why Horafirm couldn't say ("denied": it turned the key down).
 */
export type DeskwispWorkspaceFound =
  | { kind: "found"; id: string; memberCount?: number; cached?: true }
  | { kind: "none" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "error"; status: number };

/**
 * The user's own "deskwisp" workspace, found and never made, with `key` (theirs, signed in): the id
 * deskwispWorkspace() already has for them (unless `fresh`), else the one they own named "deskwisp" (any case,
 * spaces trimmed). Never one shared with them, never another of theirs (unlike ownedWorkspace), and
 * nothing is made (unlike deskwispWorkspace): "none" until a bot of theirs has had a computer. The people
 * the user adds are this workspace's members (lib/server/members.ts).
 */
export async function findDeskwispWorkspace(key: string, { fresh = false } = {}): Promise<DeskwispWorkspaceFound> {
  const known = fresh ? undefined : await g.deskwispHorafirmWorkspace?.catch(() => undefined);
  if (known) return { kind: "found", id: known, cached: true };
  const got = await callHorafirm<{ workspaces?: unknown }>(key, "/api/workspaces");
  if (!got) return { kind: "unreachable" };
  if (got.status === 401) return { kind: "denied" };
  if (got.status !== 200) return { kind: "error", status: got.status };
  const list = Array.isArray(got.json.workspaces) ? (got.json.workspaces as (Partial<HorafirmWorkspace> & { member_count?: unknown })[]) : [];
  const mine = list.find((w) => typeof w?.id === "string" && typeof w.name === "string" && (w.role ?? "owner") === "owner" && isDeskwisp(w as HorafirmWorkspace));
  if (!mine?.id) return { kind: "none" };
  return { kind: "found", id: mine.id, ...(Number.isSafeInteger(mine.member_count) ? { memberCount: mine.member_count as number } : {}) };
}

/** A member of a workspace as horafirm-web lists it: the owner first, then everyone else (guests have no email). */
export type HorafirmMember = { id?: unknown; alt?: unknown; role?: unknown; email?: unknown };
/** An invite as horafirm-web lists it (the token only for the owner; the times from an horafirm-web that sends them). */
export type HorafirmInvite = { email?: unknown; role?: unknown; status?: unknown; token?: unknown; created_at?: unknown; expires_at?: unknown; expired?: unknown };

/**
 * Who has access to a workspace, and changes to that (horafirm-web's member routes; /api/workspaces/{id}/…
 * is its name for /api/projects/[id]/…), always with the signed-in key passed in: never HORAFIRM_API_KEY or
 * the Horafirm CLI's login. Only the owner may invite, change or remove people. Each answers Horafirm's status
 * and JSON, or null when Horafirm didn't answer. The workspace is findDeskwispWorkspace's, never one from the app.
 */
export const horafirmMembers = {
  /** The members (the owner first) and the invites still waiting; horafirm-web with plan rules adds `seats`. */
  list: (key: string, workspace: string) =>
    callHorafirm<{ members?: unknown; invites?: unknown; seats?: unknown; seats_error?: unknown; error?: unknown; code?: unknown }>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`),
  /**
   * Invite someone by email: "viewer" (View only) or "admin" (Full access). Again for the same email,
   * Horafirm replaces the invite: a new email, a new link and 7 more days, and the old link stops working.
   */
  invite: (key: string, workspace: string, email: string, permission: "viewer" | "admin") =>
    callHorafirm<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/invite`, { method: "POST", body: { email, permission } }),
  /** Cancel an invite still waiting: its link stops working. */
  revoke: (key: string, workspace: string, email: string) =>
    callHorafirm<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/invite`, { method: "DELETE", body: { email } }),
  /** Take someone's access away (Horafirm stops their open screens within seconds). */
  remove: (key: string, workspace: string, memberId: string) =>
    callHorafirm<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`, { method: "DELETE", body: { memberId } }),
  /** Change what someone can do. Horafirm's words here: "member" (View only) or "admin" (Full access). */
  setRole: (key: string, workspace: string, memberId: string, role: "member" | "admin") =>
    callHorafirm<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`, { method: "PATCH", body: { memberId, role } }),
};

/**
 * Sam's computer launches from this template (built from horafirm/deskwisp-base.mjs; keep the versions in
 * step): Horafirm's own copy, which every account can use and which is the only one a free Deskwisp computer
 * is made from (horafirm-web lib/curated-templates.ts). DESKWISP_HORAFIRM_TEMPLATE points at your own build
 * when the default isn't in your Horafirm account.
 */
export const DESKWISP_TEMPLATE = process.env.DESKWISP_HORAFIRM_TEMPLATE || "system/deskwisp-base@0.1.8";
/**
 * Every Deskwisp computer's disk, in GB (Horafirm's plan default is 20). Copies inherit their source's disk,
 * and older computers grow to this the next time Deskwisp gets them ready (see growDisk).
 */
export const DESKWISP_DISK_GB = Number(process.env.DESKWISP_DISK_GB) || 120;
/** Every screen on a Deskwisp computer: 4:3, like the template's boot screen (horafirm/deskwisp-base.mjs). */
export const DESKWISP_SCREEN = { width: 1280, height: 960 };

const grown = new Set<string>();

/**
 * Whether Deskwisp streams the boot screen over Horafirm's WebRTC (UDP): on unless DESKWISP_WEBRTC=0. Only at the
 * screen's real size, though: Horafirm's WebRTC gateway fits a screen inside its host's limit by shrinking
 * the screen itself (1280x720 unless the host sets HORAFIRM_RTC_WIDTH/HEIGHT, so a 1280x960 Deskwisp screen
 * comes out 960x720), and never sizes it back. The app sees that in the size Horafirm says it streams at,
 * stops, and streams over VNC, and Deskwisp puts the screen back (horafirm.screenShrunk). Off, Deskwisp doesn't
 * turn WebRTC on for computers and the app streams over VNC (through Horafirm).
 */
export const webrtcWanted = () => process.env.DESKWISP_WEBRTC !== "0";

/**
 * Whether the bots' other screens (100-102) stream live through Horafirm's noVNC proxy too, by ?screen=, when
 * the computer isn't on the tailnet: on unless DESKWISP_SCREEN_STREAM=0. Horafirm serves ?screen= from
 * horafirm-web's per-screen streams (on deskwisp.com since 2026-10-06); an Horafirm without them ignores ?screen= and
 * streams the boot screen, so point DESKWISP_HORAFIRM_ORIGIN at an older Horafirm only with DESKWISP_SCREEN_STREAM=0.
 * Off, those screens show as screenshots, as before.
 */
export const screenStreamWanted = () => process.env.DESKWISP_SCREEN_STREAM !== "0";

/** Computers Horafirm wouldn't turn WebRTC on for, until when: they aren't asked again on every view. */
const rtcRefused = new Map<string, number>();
const RTC_REFUSED_MS = 10 * 60_000;

/** Computers whose boot screen Horafirm's WebRTC shrank, until when: they stream over VNC till then. */
const rtcShrank = new Map<string, number>();
export const rtcShrunk = (computerId: string) => (rtcShrank.get(computerId) ?? 0) > Date.now();

export const horafirm = {
  /**
   * A new computer in the Deskwisp workspace, from the Deskwisp template, with `ram` GB of memory: the plan's
   * memory per computer (computerRam in lib/horafirm-plans.ts), so the plan runs out of computers before
   * memory, as every copy of this one is as big. Its vCPUs are the template's 4, as many as one computer
   * on the user's plan can have (Hacker 1, Startup 2, Scale 4). Without `ram` Horafirm gives it the
   * template's 16 GB, as far as the plan allows. A computer the template's size resumes from its golden
   * snapshot; a smaller one boots fresh, which takes longer.
   *
   * `free`: the user's one free Deskwisp computer (deskwisp_free), off their Horafirm plan, at the template's size
   * whatever the plan (Horafirm sets it; no `ram` is sent). Horafirm makes it only when the user has none yet,
   * in their own "deskwisp" workspace, from Horafirm's Deskwisp template; otherwise this is an ordinary create.
   */
  create: async (name: string, opts: { ram?: number; free?: boolean } = {}) => {
    const epoch = stateEpoch();
    // Never made again for a waking code: a new computer isn't a computer waking.
    const c = made(
      await call<{ id: string; name: string; status: string }>(
        "POST",
        "/computers",
        {
          workspace_id: await deskwispWorkspace(),
          name,
          template_ref: DESKWISP_TEMPLATE,
          ...(opts.free ? { deskwisp_free: true } : opts.ram ? { ram: opts.ram } : {}),
        },
        { wait: false },
      ),
    );
    changed();
    recordUsage("computer.create", {}, epoch);
    return c;
  },

  /**
   * Grow a computer's disk to DESKWISP_DISK_GB (or the plan's most, if that's less). Disks only grow,
   * and on Linux it happens live: no restart, and the filesystem fills the new space by itself.
   */
  growDisk: async (computerId: string) => {
    if (grown.has(computerId)) return;
    const d = await call<{ current_disk_gb: number; max_disk_gb: number }>("GET", `/computers/${computerId}/resize`);
    const want = Math.min(DESKWISP_DISK_GB, d.max_disk_gb);
    if (d.current_disk_gb < want) await call("PATCH", `/computers/${computerId}/resize`, { disk_size_gb: want });
    grown.add(computerId);
  },

  /**
   * What the live desktop view needs (see /api/vnc): the computer's VNC password, which also opens
   * Horafirm's stream sockets (?token=), and whether Horafirm's WebRTC is on for it (instance_details.webrtc:
   * true, false when someone turned it off on Horafirm, null when nobody chose, which means off on
   * production), and whether it's running. Server-side only: hand the password only to the user's own
   * app on this Mac, never to anything remote. It changes when the computer restarts, so it's read
   * fresh each time.
   */
  streamInfo: async (computerId: string) => {
    const c = await call<{ vnc_password: string; status?: string; instance_details?: { webrtc?: unknown } | null }>("GET", `/computers/${computerId}`);
    const webrtc = c.instance_details?.webrtc;
    return { password: c.vnc_password, webrtc: typeof webrtc === "boolean" ? webrtc : null, running: c.status === "running" && !!c.instance_details };
  },

  /**
   * Turn on Horafirm's WebRTC (UDP) video for a computer, so its screen streams over UDP rather than VNC.
   * It's one setting on Horafirm's side (POST /computers/{id}/webrtc): nothing restarts. Horafirm forgets it
   * when a computer stops, so Deskwisp turns it on when it sets a computer up and again whenever the view
   * finds nobody chose (see /api/vnc). Only then: a choice someone made on Horafirm (off too) stands. And
   * only while the computer runs: a stopped one has no record on Horafirm (instance_details is null), and
   * saving the choice would make one, which Horafirm then takes for a running computer. Horafirm turns it down
   * where it can't stream (409: fewer than 4 vCPUs, or UDP streaming off on Horafirm's side); that
   * computer isn't asked again for 10 minutes. `known`: what streamInfo just said, so it isn't read
   * again. Says whether it's on.
   */
  webrtc: async (computerId: string, known?: { webrtc: boolean | null; running: boolean }) => {
    if (!webrtcWanted() || (rtcRefused.get(computerId) ?? 0) > Date.now()) return false;
    const now = known ?? (await horafirm.streamInfo(computerId));
    if (now.webrtc !== null) return now.webrtc;
    if (!now.running) return false;
    try {
      const r = await call<{ webrtc?: boolean | null }>("POST", `/computers/${computerId}/webrtc`, { enabled: true });
      rtcRefused.delete(computerId);
      return r.webrtc === true;
    } catch (e) {
      if (e instanceof HorafirmError && e.status < 500) rtcRefused.set(computerId, Date.now() + RTC_REFUSED_MS);
      throw e;
    }
  },

  /**
   * Horafirm's WebRTC gateway shrank the computer's boot screen to fit its limit (the app saw it in the
   * stream's size): it streams over VNC for a day (rtcShrunk, RTC_SHRUNK_MS), and the screen goes back to
   * DESKWISP_SCREEN. Horafirm resizes a screen in place (xrandr on the computer), so its windows stay open.
   */
  screenShrunk: async (computerId: string) => {
    rtcShrank.set(computerId, Date.now() + RTC_SHRUNK_MS);
    await call("PATCH", `/computers/${computerId}/screens/${screenId(99)}`, DESKWISP_SCREEN);
  },

  /** Every computer in the Deskwisp workspace (and only that workspace). */
  deskwispComputers: async () =>
    ((await call<{ desktops?: { id: string; name: string }[] }>("GET", `/workspaces/${await deskwispWorkspace()}`)).desktops ?? []).map((d) => ({ id: d.id, name: d.name })),

  /**
   * Delete a computer, but only one in the Deskwisp workspace (or the one DESKWISP_HORAFIRM_WORKSPACE pinned:
   * computers made there before sign-in are Deskwisp' too, when the account that signed in can reach them).
   */
  remove: async (computerId: string) => {
    const epoch = stateEpoch();
    const c = await call<{ project_id?: string; workspace_id?: string }>("GET", `/computers/${computerId}`);
    const where = c.workspace_id ?? c.project_id;
    if (where !== (await deskwispWorkspace()) && (!where || where !== process.env.DESKWISP_HORAFIRM_WORKSPACE))
      throw new Error(`refusing to delete ${computerId}: not a Deskwisp computer`);
    await call("DELETE", `/computers/${computerId}`);
    changed();
    recordUsage("computer.remove", {}, epoch);
  },

  /** Public facts about a computer. Never pass the raw response on: it carries the VNC password. */
  computer: async (computerId: string): Promise<HorafirmComputer> => {
    const c = await call<HorafirmComputer>("GET", `/computers/${computerId}`);
    return { id: c.id, name: c.name, status: c.status, cpu: c.cpu, ram: c.ram, os: c.os };
  },

  /**
   * Fork a running computer: a copy of its live memory as well as its disk, so open apps,
   * browser tabs and screens carry over. Horafirm's fork takes the computer's instance id (its UUID
   * answers 404) and returns the new computer's UUID. Firecracker VMs can't be forked (QEMU ones
   * can), so callers fall back to clone. A fork or clone lands on the source's server, so it needs
   * that much free memory there.
   */
  fork: async (computerId: string) => {
    const epoch = stateEpoch();
    const c = await call<{ instance_details?: { id?: string } }>("GET", `/computers/${computerId}`);
    if (!c.instance_details?.id) throw new Error("this computer can't be forked (no instance id)");
    const forked = made(await call<{ id: string; name: string; status: string }>("POST", `/computers/${c.instance_details.id}/fork`, undefined, { wait: false }));
    changed();
    recordUsage("computer.create", {}, epoch);
    return forked;
  },

  clone: async (computerId: string, name: string) => {
    const epoch = stateEpoch();
    const cloned = made(await call<{ id: string; name: string; status: string }>("POST", `/computers/${computerId}/clone`, { name }, { wait: false }));
    changed();
    recordUsage("computer.create", {}, epoch);
    return cloned;
  },

  screens: async (computerId: string) =>
    (await call<{ screens: HorafirmScreen[] }>("GET", `/computers/${computerId}/screens`)).screens,

  /**
   * Start another screen. Deskwisp computers are 4:3 (see DESKWISP_SCREEN); we pass the size because Horafirm
   * still records a template computer's boot screen as 1280x720 and would size new screens to that.
   */
  createScreen: (computerId: string) => call<HorafirmScreen>("POST", `/computers/${computerId}/screens`, DESKWISP_SCREEN),

  destroyScreen: (computerId: string, screenId: string) => call("DELETE", `/computers/${computerId}/screens/${screenId}`),

  bash: async (computerId: string, command: string, timeout = 60) =>
    (await call<{ output: string; exit_code: number }>("POST", `/computers/${computerId}/bash`, { command, timeout })),

  /** Input on one screen, for when the user takes over. Queued with screenshots so they don't collide. */
  click: (computerId: string, screen: string, x: number, y: number, double = false) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/click?screen=${screen}`, { x: Math.round(x), y: Math.round(y), double })),
  type: (computerId: string, screen: string, text: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/type?screen=${screen}`, { text })),
  key: (computerId: string, screen: string, key: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/key?screen=${screen}`, { key })),

  /**
   * Raw screenshot bytes for one screen. Horafirm fails overlapping screenshots of one computer,
   * and the app watches several screens at once, so they queue per computer and retry once.
   * JPEG for the app's views; PNG at full size for the computer tool (computer-task.ts).
   */
  screenshot: (computerId: string, screen: string, scale = 0.75, format: "jpeg" | "png" = "jpeg") =>
    inLane(computerId, async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(
          `${base()}/computers/${computerId}/screenshot?screen=${screen}&response_format=binary&format=${format}&scale=${scale}`,
          { headers: { ...horafirmHeaders(), Authorization: `Bearer ${await apiKey()}` }, cache: "no-store" },
        );
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        // With its status (and Horafirm's code when it sent one), so a computer that's gone is told apart from
        // one that's asleep (see healIfGone in sessions.ts, and computerAsleepError).
        if (attempt === 1 || res.status < 500) {
          const said = await res.json().catch(() => null);
          throw new HorafirmError(`screenshot ${res.status}`, res.status, typeof said?.code === "string" ? said.code : undefined, typeof said?.error === "string" ? said.error : undefined);
        }
      }
    }),

  /**
   * Wake a computer that's asleep (suspended), for the user who just took over one of its screens:
   * horafirm-web's explicit resume, which says so when it can't (402 deskwisp_free_hours once Free's 10 hours
   * this month are used). A running one is left as it is. One that sleeps in storage answers at once
   * (202, `waking`) and runs a minute or a few later; the caller waits for it as it sees fit, so this
   * never waits on a waking code itself.
   */
  resume: (computerId: string) =>
    call<{ waking?: boolean; pending?: boolean; expected_seconds?: number }>("POST", `/computers/${computerId}/resume`, undefined, { wait: false }),
};

/**
 * Horafirm didn't wake a computer that's asleep for a read of it (409 computer_asleep: horafirm-web leaves
 * Free's computer asleep after 15 minutes nobody used it, and answers a screenshot with this). The
 * computer is still there: asleep, never gone.
 */
export const computerAsleepError = (e: unknown) => e instanceof HorafirmError && e.status === 409 && e.code === "computer_asleep";

/** A device paired to route computers' browsing through it (Horafirm's personal-device egress). */
export type HorafirmEgressDevice = { id: string; name: string; online: boolean | null; computers?: unknown };

/**
 * Personal-device egress: a Mac paired with Horafirm carries a computer's browsing out through its own
 * internet. Horafirm answers 403 where it isn't available yet (see HorafirmUnavailable).
 */
export const egress = {
  /** This user's paired devices, whether each is connected right now (null: Horafirm couldn't tell), and where agents dial. */
  devices: () => call<{ devices?: HorafirmEgressDevice[]; rendezvous?: string | null }>("GET", "/egress-devices"),
  /** Pair a new device. The pairing code comes back only here: keep it server side. */
  pair: (name: string) => call<{ id: string; name: string; pairing_code: string; rendezvous?: string | null }>("POST", "/egress-devices", { name }),
  /** Which way a computer's browsing goes out now. */
  upstream: (computerId: string) =>
    call<{ mode: "residential" | "device" | "custom"; device_id?: string | null; proxy_on: boolean }>("GET", `/computers/${computerId}/egress/upstream`),
  /**
   * Route a computer's browsing. Horafirm applies it right away: when the proxy was off, turning a route
   * on restarts the computer's Chrome; when it was on, only the route underneath changes.
   */
  setUpstream: (computerId: string, mode: "residential" | "device", deviceId?: string) =>
    call<{ proxy_on?: boolean }>("POST", `/computers/${computerId}/egress/upstream`, { mode, ...(deviceId ? { device_id: deviceId } : {}) }),
  /** Turn a computer's proxy off: browsing goes out directly again (this restarts its Chrome too). */
  proxyOff: (computerId: string) => call("POST", `/computers/${computerId}/residential-proxy`, { enabled: false }),
};

/** Horafirm said a feature isn't available for this account (403). */
export const horafirmUnavailable = (e: unknown) => / → 403:/.test((e as Error)?.message ?? "");

/** Screen id for an X display number: 99 is the boot screen, 100-102 are created screens. */
export const screenId = (display: number) => (display === 99 ? "default" : `screen-${display}`);
