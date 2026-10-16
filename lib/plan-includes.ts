/**
 * What each Deskwisp plan includes, in the words the app shows (and, once there is one, Deskwisp's own
 * website: keep its pricing in step), and why a plan has no room
 * for one more phone number, email or computer. The numbers are DESKWISP_TIERS (cloud/protocol.ts),
 * which horafirm-web and Deskwisp Cloud hold each plan to:
 *
 * - Every plan has one Deskwisp computer; what grows is how many screens each bot has on it (they open
 *   while it works, so it can do that many things at once), and how many hours a month it may run
 *   (it sleeps when nothing's using it, so only the time it works counts).
 * - Free: $1 of AI credit once, 10 computer hours a month, 1 screen; no email.
 * - Pro, $29 a month: $10 of AI credit every month, 60 hours, 2 screens, 1 email (the main bot's, set
 *   up with the plan).
 * - Max, $199 a month: $100 of AI credit every month, 300 hours, all 4 screens, and up to 5 emails (the
 *   main bot's with the plan, the others when the user asks).
 * - People who can see the bots' computers (the People sheet): none on Free, 2 on Pro, up to 5 on Max.
 *
 * Phone numbers are in DESKWISP_TIERS too, but Deskwisp doesn't offer them yet, so the cards don't say so.
 *
 * Shared by the server and the app (no server imports).
 */
import { DESKWISP_TIERS, type DeskwispTier } from "@/cloud/protocol";

/** One line on a plan's card: something it includes, or (`no`) something it doesn't. */
export type PlanLine = { text: string; no?: true };

/**
 * The Deskwisp computers a plan includes, first on its card and set apart from its lines so nobody misses
 * how many: `title` the count ("1 computer included"), `detail` what each one is.
 */
export type PlanComputers = { title: string; detail: string };

export type PlanCard = { tier: DeskwispTier; name: string; price: string; per?: string; computers: PlanComputers; lines: PlanLine[] };

/** "1 screen per bot", "4 screens per bot" on the plan's one computer (one line on a card): DESKWISP_TIERS' count. */
const included = (tier: DeskwispTier) => {
  const n = DESKWISP_TIERS[tier].screens;
  return `1 computer, ${n} screen${n === 1 ? "" : "s"} per bot`;
};

/** Dollars, as a card says them: "$29", "$1", "$0.50". */
const dollars = (micros: number) => `$${Number.isInteger(micros / 1e6) ? micros / 1e6 : (micros / 1e6).toFixed(2)}`;
const hoursLine = (tier: DeskwispTier) => `${DESKWISP_TIERS[tier].hours} computer hours a month`;

/** The three plans, as the account sheet and Deskwisp's site list them. */
export const PLAN_CARDS: PlanCard[] = [
  {
    tier: "free_deskwisp",
    name: "Free",
    price: "$0",
    computers: { title: included("free_deskwisp"), detail: "Each bot works on one thing at a time; screens open only while they work" },
    lines: [
      { text: `${dollars(DESKWISP_TIERS.free_deskwisp.creditMicros)} of AI credit, once` },
      { text: hoursLine("free_deskwisp") },
      { text: "As many bots as you like, sharing it" },
      { text: "No email for your bots", no: true },
      { text: "No sharing with other people", no: true },
    ],
  },
  {
    tier: "pro_deskwisp",
    name: "Pro",
    price: dollars(DESKWISP_TIERS.pro_deskwisp.priceCents * 10_000),
    per: "/month",
    computers: { title: included("pro_deskwisp"), detail: "Each bot does two things at once; screens open only while they work" },
    lines: [
      { text: `${dollars(DESKWISP_TIERS.pro_deskwisp.creditMicros)} of AI credit every month` },
      { text: hoursLine("pro_deskwisp") },
      { text: "As many bots as you like, sharing it" },
      { text: "An email address for your main bot" },
      { text: `Share your bots' computers with ${DESKWISP_TIERS.pro_deskwisp.people} people` },
    ],
  },
  {
    tier: "max_deskwisp",
    name: "Max",
    price: dollars(DESKWISP_TIERS.max_deskwisp.priceCents * 10_000),
    per: "/month",
    computers: { title: included("max_deskwisp"), detail: "Each bot does four things at once; screens open only while they work" },
    lines: [
      { text: `${dollars(DESKWISP_TIERS.max_deskwisp.creditMicros)} of AI credit every month` },
      { text: hoursLine("max_deskwisp") },
      { text: "As many bots as you like, on any of them" },
      { text: `Up to ${DESKWISP_TIERS.max_deskwisp.emails} email addresses for your bots` },
      { text: `Share your bots' computers with up to ${DESKWISP_TIERS.max_deskwisp.people} people` },
    ],
  },
];

/**
 * Free's computer time, as Horafirm counts it (horafirm-web lib/deskwisp-free-hours.ts, GET /api/deskwisp/plan's
 * computer_time): seconds used this month, of how many, and when they start over (Unix ms).
 */
export type FreeHours = { usedSeconds: number; limitSeconds: number; resetsAt: number };

/** Seconds as hours: "2", "2.5", "10". */
const hoursOf = (seconds: number) => {
  const h = seconds / 3600;
  return h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h).toLocaleString("en-US");
};

/**
 * Whether Horafirm counts Free's hours by the month: they start over on the 1st at 00:00 UTC (horafirm-web
 * periodEndOf). The answer names no period, and an Horafirm that still counts by the week starts them over
 * on a Monday, so then the words leave the period out instead of saying "a month".
 */
const byTheMonth = (resetsAt: number) => resetsAt % 86_400_000 === 0 && new Date(resetsAt).getUTCDate() === 1;

/**
 * The day Free's hours start over ("Nov 1"): the UTC day, the one Horafirm's own words name, so the hours
 * are always back by the day it says (west of UTC they're back the evening before).
 */
const backOn = (resetsAt: number) => new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The plan with more hours than this one, if any. */
const biggerPlan = (tier: DeskwispTier) => (tier === "free_deskwisp" ? "Pro" : tier === "pro_deskwisp" ? "Max" : null);

/**
 * The computer has used its plan's hours (this month's, when they're counted by the month), and when
 * they're back. `tier`: whose hours (Free's when not said), for the plan to upgrade to.
 */
export const freeHoursOutLine = (t: FreeHours, tier: DeskwispTier = "free_deskwisp") => {
  const up = biggerPlan(tier);
  return `Your Deskwisp computer has used its ${hoursOf(t.limitSeconds)} hours${byTheMonth(t.resetsAt) ? " this month" : ""}. It's back ${backOn(t.resetsAt)}${up ? `, or upgrade to ${up} to keep it on` : ""}.`;
};

/**
 * Free's computer time in the account sheet's words: `amount` the figure ("2 of 10 hours used", rounded
 * down to a tenth, so it reads all used only once they are) with `label` under it, and `note` beside them:
 * what Free includes and when the hours start over, or, once they're used, when they're back. "A month"
 * and "this month" only when Horafirm counts by the month (byTheMonth); otherwise no period at all.
 */
export function freeHoursWords(t: FreeHours, tier: DeskwispTier = "free_deskwisp"): { note: string; amount: string; label: string } {
  const limit = hoursOf(t.limitSeconds);
  const monthly = byTheMonth(t.resetsAt);
  const sleeps = "sleeps when nothing's using it, so only the time it works counts.";
  return {
    note:
      t.usedSeconds >= t.limitSeconds
        ? freeHoursOutLine(t, tier)
        : `${monthly ? `${DESKWISP_TIERS[tier].name} includes ${limit} hours a month on your Deskwisp computer. It ${sleeps}` : `Your Deskwisp computer ${sleeps}`} Your hours start over ${backOn(t.resetsAt)}.`,
    amount: `${hoursOf(Math.floor(Math.min(t.usedSeconds, t.limitSeconds) / 360) * 360)} of ${limit} hours used`,
    label: monthly ? "Computer time this month" : "Computer time",
  };
}

/**
 * Why there's no room for one more, and the plan that has room: "plan" (Free: Pro or Max both
 * would), "max" (Pro: only Max), or null (Max: nothing more to buy).
 */
export type PlanRoomShort = { text: string; upgrade: "plan" | "max" | null };

const MAX = DESKWISP_TIERS.max_deskwisp;

/** The upgrade button for a short: "Purchase a plan" from Free, "Upgrade to Max" from Pro. */
export const upgradeLabel = (upgrade: "plan" | "max") => (upgrade === "plan" ? "Purchase a plan" : "Upgrade to Max");

/**
 * Whether `bot` may have one more phone number, with `held` numbers on the account now (the main
 * bot's from the plan included): null when it may. On Pro the one number is the main bot's, which the
 * plan sets up itself. The words are Deskwisp Cloud's refusal's (cloud/plans.ts numberRefusal), exactly.
 */
export function numberShort(tier: DeskwispTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "free_deskwisp") return { text: `Free doesn't include a phone number. Pro includes ${DESKWISP_TIERS.pro_deskwisp.phoneNumbers}, and Max up to ${MAX.phoneNumbers}.`, upgrade: "plan" };
  if (tier === "pro_deskwisp") {
    if (bot.isPlanBot && held < DESKWISP_TIERS.pro_deskwisp.phoneNumbers) return null;
    return { text: `Pro includes ${DESKWISP_TIERS.pro_deskwisp.phoneNumbers} phone number. Max includes up to ${MAX.phoneNumbers}.`, upgrade: "max" };
  }
  return held < MAX.phoneNumbers ? null : { text: `Max includes up to ${MAX.phoneNumbers} phone numbers, and you have ${MAX.phoneNumbers}.`, upgrade: null };
}

/** The same for an email, in the same words: `held` is how many of the user's bots have an inbox. */
export function emailShort(tier: DeskwispTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "free_deskwisp") return { text: `Free doesn't include an email. Pro includes ${DESKWISP_TIERS.pro_deskwisp.emails}, and Max up to ${MAX.emails}.`, upgrade: "plan" };
  if (tier === "pro_deskwisp") {
    if (bot.isPlanBot) return null;
    return { text: `Pro includes ${DESKWISP_TIERS.pro_deskwisp.emails} email. Max includes up to ${MAX.emails}.`, upgrade: "max" };
  }
  return held < MAX.emails ? null : { text: `Max includes up to ${MAX.emails} emails, and you have ${MAX.emails}.`, upgrade: null };
}

/**
 * The same for a Deskwisp computer: `held` is how many the user has (the free one included) and `more`
 * how many a bot's own computer takes (2 when the free one isn't made yet: the main bot's comes first).
 * The words are horafirm-web's create gate's refusal (DESKWISP_COMPUTER_LIMIT, lib/deskwisp-max-computers.ts), exactly.
 */
export function computerShort(tier: DeskwispTier, held: number, more = 1): PlanRoomShort | null {
  const limit = DESKWISP_TIERS[tier].computers;
  if (held + more <= limit) return null;
  // Every plan has one computer: what grows with the plan is its screens.
  return { text: `${DESKWISP_TIERS[tier].name} includes ${limit} Deskwisp computer. A bigger plan gives it more screens.`, upgrade: tier === "max_deskwisp" ? null : "max" };
}

/* ---------------- People ---------------- */

/**
 * Where the user's plan stands on people who can see their bots' computers (lib/members.ts
 * MemberSeats): the plan, how many people it includes besides the user (null: no limit), how many
 * have access or an invite still waiting, and how many Pro and Max include.
 */
export type PeopleRoom = { plan: DeskwispTier; limit: number | null; used: number; caps: { pro_deskwisp: number; max_deskwisp: number } };

/** What Pro and Max include, from DESKWISP_TIERS: named in the People sheet only when horafirm-web's seats leave their caps out. */
export const PEOPLE_CAPS = { pro_deskwisp: DESKWISP_TIERS.pro_deskwisp.people, max_deskwisp: DESKWISP_TIERS.max_deskwisp.people } as const;

/** "1 person", "2 people". */
export const peopleCount = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** The counter beside Add someone ("1 of 2 people"); null when there's no limit. */
export const peopleAside = (s: PeopleRoom) => (s.limit === null ? null : `${s.used} of ${s.limit === 1 ? "1 person" : `${s.limit} people`}`);

/**
 * Why the user can't add someone now, in the People sheet's words, and the plan that has room: null when
 * they can. `withAccess`: the people who have access now (not invites); `invited`: invites still waiting.
 * People over a limit keep their access (a plan changed after they joined): the words say so, and that
 * adding someone needs room first. `note`: a second line, when cancelling an invite would make room.
 * The numbers are horafirm-web's (it holds the workspace to them).
 */
export function peopleShort(s: PeopleRoom, { withAccess, invited }: { withAccess: number; invited: number }): (PlanRoomShort & { note?: string }) | null {
  const max = s.caps.max_deskwisp;
  if (s.plan === "free_deskwisp" || s.limit === 0) {
    const keep = withAccess === 1 ? "The 1 person who has access keeps it." : `The ${withAccess} people who have access keep it.`;
    return { text: `Free doesn't include adding people. ${withAccess > 0 ? keep : `Pro includes ${s.caps.pro_deskwisp}, and Max up to ${max}.`}`, upgrade: "plan" };
  }
  if (s.limit === null || s.used < s.limit) return null;
  const over = s.used > s.limit;
  if (s.plan === "pro_deskwisp")
    return over
      ? { text: `Pro includes ${peopleCount(s.limit)}, and you have ${s.used} from before. They keep access, but to add someone, upgrade to Max or remove people.`, upgrade: "max" }
      : { text: `Pro includes ${peopleCount(s.limit)}, and you have ${s.used}. Max includes up to ${max}.`, upgrade: "max", ...(invited ? { note: "Or cancel an invite below to make room." } : {}) };
  return over
    ? { text: `Max includes up to ${peopleCount(s.limit)}, and you have ${s.used} from before. They keep access, but to add someone, remove people first.`, upgrade: null }
    : { text: `Max includes up to ${peopleCount(s.limit)}, and you have ${s.used}. ${invited ? "Remove someone or cancel an invite" : "Remove someone"} to add someone else.`, upgrade: null };
}
