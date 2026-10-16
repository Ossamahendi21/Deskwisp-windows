/**
 * People who can see the user's bots' computers, shared by the app's People sheet (components/app/
 * members.tsx) and its route (app/api/members, lib/server/members.ts). No server imports.
 *
 * On Deskwisp Cloud (dcloud/src/people.ts) the people are kept there: they accept an invite link signed
 * in as the email invited, and watch (or use) the bots' computers live in their browser at its /watch
 * page, as the user can too. The rest of this comment is how it works against deskwisp.com:
 *
 * Every Deskwisp computer of every Deskwisp workspace lives in one Horafirm workspace the user owns, named "deskwisp"
 * (lib/server/horafirm.ts deskwispWorkspace). The people the user adds are members of that Horafirm workspace:
 * they sign in on deskwisp.com and see the bots' computers there, never this PC, the chats or the vault.
 * Deskwisp keeps none of this itself: horafirm-web holds the list, the invites and the plan's rules (Free
 * adds nobody, Pro 2 people, Max up to 5), and the app shows what it says. Nobody is added from an
 * horafirm-web that doesn't send its numbers (seats): one from before that rule holds no plan to it.
 *
 * Horafirm's two roles keep Horafirm's names, so an invitee reads the same words on deskwisp.com: View only (Horafirm's
 * "member": watch the screens, change nothing) and Full access (Horafirm's "admin": use the computers as
 * the user can).
 */
import type { DeskwispTier } from "@/cloud/protocol";

/** What someone can do on the bots' computers: "viewer" is Horafirm's member (View only), "admin" Full access. */
export type MemberRole = "viewer" | "admin";

/** Someone with access besides the user. `guest`: joined with a link made on deskwisp.com, so no email. */
export type Person = { id: string; name: string; email?: string; role: MemberRole; guest: boolean };

/**
 * An invite still waiting. `expiresAt`: Unix ms, null from an horafirm-web that doesn't say. `link`: the
 * accept page, which works only for someone signed in to Horafirm with the invited email.
 */
export type Invite = { email: string; role: MemberRole; expiresAt: number | null; expired: boolean; link?: string };

/**
 * Where the plan stands on people: horafirm-web's numbers, which it holds the workspace to (never the
 * app's guess). `limit`: people besides the user (null: no limit). `used`: people with access and
 * invites still waiting. `upgrade`: the plan with more room ("plan" from Free, "max" from Pro).
 */
export type MemberSeats = {
  plan: DeskwispTier;
  canAdd: boolean;
  limit: number | null;
  used: number;
  upgrade: "plan" | "max" | null;
  caps: { pro_deskwisp: number; max_deskwisp: number };
};

/**
 * Why there are no seats, so nobody is added: horafirm-web couldn't read the plan (PLAN_UNAVAILABLE), or it
 * sent no seats at all (HORAFIRM_NOT_READY): an horafirm-web from before its plan rule, which also shows View
 * only the commands the bots run.
 */
export type SeatsError = "PLAN_UNAVAILABLE" | "HORAFIRM_NOT_READY";

/**
 * Whether the app offers Full access: "on"; "off" while Deskwisp puts its own keys on the bots' computers
 * (someone with Full access is root there and could read them); "not_yet" until removing someone ends
 * every way they had in (FULL_ACCESS_IN_DESKWISP).
 */
export type FullAccess = "on" | "off" | "not_yet";

/** GET /api/members: who has access, or why the sheet can't say. */
export type MembersInfo =
  | { state: "self_hosted"; horafirmUrl: string }
  | { state: "signed_out"; why: "no_key" | "rejected" }
  | { state: "no_computers" }
  | {
      state: "ready";
      /** The workspace on deskwisp.com. */
      horafirmUrl: string;
      /** Where the bots work now: on this PC, people the user adds see nothing of it. */
      host: "horafirm" | "mac";
      fullAccess: FullAccess;
      /**
       * Deskwisp puts keys of its own on the bots' computers (DESKWISP_LISTEN_ALL's apps.json, the executor's
       * key, Tailscale's): anyone with Full access, root there, can read them, offered or not.
       */
      keysOnComputers: boolean;
      you: { id: string; name: string; email?: string };
      people: Person[];
      invites: Invite[];
      seats: MemberSeats | null;
      seatsError?: SeatsError;
    };

/** Why a members call didn't do what was asked: a code the app acts on, and words to show. */
export type MembersRefusal = {
  code: string;
  error: string;
  upgrade?: "plan" | "max" | null;
  limit?: number;
  used?: number;
  why?: "no_key" | "rejected";
};

/** POST /api/members's answer: the invite went out, or (emailSent false) it's made and `link` is for the user to send. */
export type InviteSent = { email: string; role: MemberRole; emailSent: boolean; link?: string };

/**
 * Full access in the app. Off until removing someone with Full access also changes the computers'
 * passwords (horafirm-web and the hosts): someone removed could still use a password they copied. Until
 * then the sheet adds people with View only, and can move anyone with Full access to View only or
 * remove them, saying a password they copied outlasts that (WORDS.copiedPassword).
 * DESKWISP_MEMBERS_FULL_ACCESS=1 offers it before that (lib/server/members.ts).
 */
export const FULL_ACCESS_IN_DESKWISP = false;

/** The roles in Horafirm's words. */
export const ROLE_NAMES: Record<MemberRole, string> = { viewer: "View only", admin: "Full access" };

/** What each role means, under the invite form and in the Give Full access dialog: Full access's is the one warning. */
export const ROLE_LINES: Record<MemberRole, string> = {
  viewer: "They can watch your bots' screens live, but can't click, type or change anything on them.",
  admin: "They can use your bots' computers as you can, including sites your bots are signed in to.",
};

/** An address the form sends: trimmed, lowercased, and shaped like name@domain.tld. Null when it isn't. */
export function emailOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(email) ? email : null;
}

/** Everything the sheet and its route say, in one place (the tests check them for dashes). */
export const WORDS = {
  unreachable: "Couldn't reach Deskwisp Cloud. Check your internet connection and try again.",
  horafirmError: "Deskwisp Cloud couldn't do that just now. Try again in a minute.",
  horafirmLoadError: "Deskwisp Cloud couldn't load who has access. Try again in a minute.",
  loadFailed: "Couldn't load who has access.",
  noKey: "Deskwisp can't use your sign-in right now. Sign out, then sign in again.",
  rejected: "Deskwisp Cloud didn't accept this PC's sign-in. Sign out, then sign in again.",
  selfHosted:
    "Adding people needs Deskwisp Cloud: point DESKWISP_HORAFIRM_ORIGIN at it. Self-hosted setups can keep your own keys on your bots' computers, so give Full access only to people you'd trust with those keys.",
  noComputers: "Your bots don't have a computer yet. Once they do, you can add people to watch it here.",
  planUnavailable: "Couldn't check your plan just now, so adding people is paused. Try again in a minute.",
  planUnavailableShort: "Couldn't check your plan just now. Try again in a minute.",
  horafirmNotReady: "Adding people isn't ready yet. Once it is, you can add them here.",
  horafirmNotReadyShort: "Adding people isn't ready yet.",
  upgradeRequired: "Your plan doesn't include adding people right now.",
  seatLimit: "Your plan has no room for more people right now.",
  rateLimited: "That's a lot of invites for now. Try again in an hour.",
  self: "That's your own email.",
  badEmail: "Check the email address.",
  gone: "They don't have access anymore.",
  notOwner: "Only the owner can do that.",
  windowOnly: "People can only be added in the Deskwisp app.",
  fullAccessOff: "Full access is off while your bots' computers hold keys from this PC.",
  fullAccessOffTip: "Off while your bots' computers hold keys from this PC.",
  fullAccessNotYet: "Deskwisp adds people with View only for now.",
  keysOff: "Your bots' computers hold keys from this PC, so Full access is off.",
  keysOffFull: "Anyone who already has it can read those keys. Switch them to View only.",
  keysHeld: "Your bots' computers hold keys from this PC. Anyone with Full access can read them. Switch them to View only.",
  copiedPassword: "A computer password they copied keeps working until it's changed.",
  appUnreachable: "Couldn't reach Deskwisp. Try again.",
  whatToSend: "Say who to add, and what they can do.",
  alreadyIn: (email: string) => `${email} already has access.`,
};
