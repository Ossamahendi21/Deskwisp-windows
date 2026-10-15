import type { CloudUsage } from "@/cloud/protocol";
import type { AccountInfo, HorafirmBilling, SpendKind, TokenSource, UsageTotals } from "@/lib/account";
import { deskwispComputers, planName, planShort, planShortText, planUp } from "@/lib/horafirm-plans";
import { cloudJson, cloudOn } from "@/lib/server/cloud";
import { loadHorafirmKey, horafirmKey, signedInUser } from "@/lib/server/horafirm-auth";
import { prettyPhone } from "@/lib/server/phone";
import { askHorafirm, horafirmPages, horafirmPlan, readDeskwispPlan } from "@/lib/server/plan";
import { getState } from "@/lib/server/store";
import { usageSince } from "@/lib/server/usage";
import { MAIN_WORKSPACE, workspaceOf, type UsageEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The account page (components/app/account.tsx), assembled here so the Horafirm key stays on the
 * server: who's signed in, their Deskwisp plan and AI credit, their Horafirm plan with its computers in use,
 * credits and compute (read from Horafirm with their key), Deskwisp' own usage this month and last (Deskwisp
 * Cloud's count of what AI credit paid for, and this Mac's ledger, lib/server/usage.ts), and the
 * inboxes and numbers their bots have.
 */
export async function GET() {
  const state = getState();
  const user = signedInUser();
  const key = user ? await loadHorafirmKey().then(() => horafirmKey()) : null;
  const now = new Date();
  // Months on the user's own clock: this server runs on their Mac.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const events = usageSince(lastMonthStart);
  const pages = horafirmPages();
  // AI credit is Deskwisp Cloud's: only when the app works through it, and so is its count of what it paid for.
  const viaCloud = !!key && cloudOn();
  const [horafirm, deskwisp, cloudThis, cloudLast] = await Promise.all([
    key ? readHorafirm(key) : null,
    viaCloud ? readDeskwispPlan(key) : undefined,
    viaCloud ? cloudUsage(monthStart, now.getTime() + 60_000) : null,
    viaCloud ? cloudUsage(lastMonthStart, monthStart) : null,
  ]);
  const info: AccountInfo = {
    user,
    signedInAt: state.account?.signedInAt,
    // Signed in per the state but no key in the Keychain (locked, or it refused this build): say so, not "sign in".
    horafirm: horafirm ?? (user ? { status: "no-key" } : null),
    ...(deskwisp !== undefined ? { deskwisp } : {}),
    links: { billing: pages.plan, usage: pages.usage },
    usage: {
      thisMonth: totals(events.filter((e) => e.at >= monthStart), monthStart, cloudThis),
      lastMonth: totals(events.filter((e) => e.at < monthStart), lastMonthStart, cloudLast),
      monthStart,
      lastMonthStart,
    },
    reach: (state.workspaces?.length ? state.workspaces : [{ id: MAIN_WORKSPACE, name: "Main" }]).map((w) => {
      const bots = state.bots.filter((b) => workspaceOf(b) === w.id);
      const line = "line" in w ? w.line : undefined;
      return {
        id: w.id,
        name: w.name,
        line: line ? { phone: prettyPhone(line.phone), imessage: line.type === "imessage", main: bots.find((b) => b.isMain)?.name } : undefined,
        bots: bots
          .sort((a, b) => Number(b.isMain) - Number(a.isMain))
          .map((b) => ({ id: b.id, name: b.name, color: b.color, isMain: b.isMain, email: b.email, phone: b.phone ? prettyPhone(b.phone) : undefined })),
      };
    }),
  };
  return Response.json(info);
}

/* ---------------- Horafirm ---------------- */

type Summary = {
  tier?: string;
  /** The plan the account is held to, which its computers count against (`tier` is the live subscription's). */
  entitledTier?: string;
  interval?: "month" | "year" | null;
  renewalDate?: number | null;
  cancelAtPeriodEnd?: boolean;
  amountCents?: number | null;
  currency?: string | null;
  comped?: boolean;
  compExpiresAt?: number | null;
  hasActiveSubscription?: boolean;
};
type Credits = { balanceCents?: number; tier?: string };
type Quota = { allocated?: { vms?: number }; usage_mtd?: { cpu_seconds?: number; running_seconds?: number } };

/**
 * Plan, credits and compute, as Horafirm for Mac reads them, all with an account API key (validateAuth's
 * Bearer sk_ path), and the plan's computers as Horafirm counts them for a new one (lib/server/plan.ts).
 * Each can fail on its own; the page shows what came back and says what didn't.
 */
async function readHorafirm(key: string): Promise<HorafirmBilling> {
  const [summary, credits, quota, plan] = await Promise.all([
    askHorafirm<Summary>(key, "/api/billing/summary"),
    askHorafirm<Credits>(key, "/api/credits"),
    askHorafirm<Quota>(key, "/api/billing/quota"),
    horafirmPlan({ fresh: true }),
  ]);
  const reads = [summary, credits, quota];
  const failed = reads.filter((r) => !r.ok);
  if (failed.length === reads.length && !plan) return { status: failed.some((r) => !r.ok && r.denied) ? "expired" : "unreachable" };

  const out: HorafirmBilling = { status: failed.length || !plan ? "partial" : "ok" };
  const s = summary.ok ? summary.json : undefined;
  // The plan the account is held to, which its computers count against; else the live subscription's.
  const tier = plan?.tier ?? s?.entitledTier ?? (s?.hasActiveSubscription ? s.tier : undefined) ?? (credits.ok ? credits.json.tier : undefined) ?? s?.tier;
  if (tier)
    out.plan = {
      tier,
      name: planName(tier),
      amountCents: s?.hasActiveSubscription ? (s.amountCents ?? undefined) : undefined,
      currency: s?.currency ?? undefined,
      interval: s?.interval ?? undefined,
      renewsAt: s?.renewalDate ? s.renewalDate * 1000 : undefined,
      cancelsAtPeriodEnd: s?.cancelAtPeriodEnd || undefined,
      comped: s?.comped || undefined,
      compEndsAt: s?.compExpiresAt ? s.compExpiresAt * 1000 : undefined,
    };
  if (plan) {
    const deskwisp = deskwispComputers(getState().bots);
    out.computers = { allowed: plan.computers, inUse: plan.inUse, outsideDeskwisp: plan.inUse === undefined ? undefined : Math.max(0, plan.inUse - deskwisp) };
    // No room for another computer: why, in plain words, under the plan's name as shown. Either way, the next plan up Horafirm sells.
    const short = planShort(plan);
    if (short) out.full = planShortText(short, { ...plan, name: out.plan?.name ?? plan.name }, { deskwisp });
    out.upgradeTo = planUp(plan)?.name;
  }
  if (credits.ok && typeof credits.json.balanceCents === "number") out.creditsCents = credits.json.balanceCents;
  if (quota.ok) {
    const q = quota.json;
    out.compute = {
      runningHours: (Number(q.usage_mtd?.running_seconds) || 0) / 3600,
      vcpuHours: (Number(q.usage_mtd?.cpu_seconds) || 0) / 3600,
      computers: Number(q.allocated?.vms) || 0,
    };
  }
  return out;
}

/* ---------------- Deskwisp usage ---------------- */

/** Deskwisp Cloud's own count of the user's use in [from, to) (the rows their AI credit paid for), days on this Mac's clock. Null when it didn't answer. */
async function cloudUsage(from: number, to: number): Promise<CloudUsage | null> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return cloudJson<CloudUsage>(`/v1/usage?${new URLSearchParams({ from: String(from), to: String(to), tz })}`).catch((e: Error) => {
    console.warn(`[account] Deskwisp Cloud's usage: ${e.message}`);
    return null;
  });
}

/** What each cloud row is on the page: tokens by kind of work, and what AI credit paid for. "iphone": the main bot's chat answered in the cloud for Deskwisp for iPhone. */
const TOKEN_SOURCE: Record<string, TokenSource> = { chat: "chat", session: "session", agent: "session", memory: "memory", call: "call", phone: "call", iphone: "chat" };
function spendKind(kind: string, source?: string): SpendKind {
  if (kind === "openai.tokens") return TOKEN_SOURCE[source ?? ""] ?? "other";
  if (kind === "openai.web_search") return "search";
  // call.minutes and typesafe.calls: rows the cloud wrote before it counted seconds and Jev's tokens.
  if (kind === "openai.live_seconds" || kind === "agentphone.voice_seconds" || kind === "call.minutes") return "call";
  if (kind === "typesafe.tokens" || kind === "typesafe.calls") return "decide";
  if (kind === "honcho.calls") return "memory";
  if (kind === "agentphone.sms") return "text";
  if (kind === "agentphone.numbers" || kind === "agentphone.plan_numbers") return "number";
  if (kind.startsWith("verify.")) return "code";
  if (kind === "composio.calls") return "app";
  if (kind === "treg.calls") return "data";
  return "other";
}

/**
 * One month, totalled. Computers, numbers and inboxes made are this Mac's ledger; model use, calls and AI credit spent are Deskwisp Cloud's count when it answered
 * (`cloud`), else this Mac's ledger. Bots that are gone keep their usage, under "Removed bot".
 */
function totals(events: UsageEvent[], monthStart: number, cloud: CloudUsage | null): UsageTotals {
  const start = new Date(monthStart);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const t: UsageTotals = {
    computersCreated: 0,
    computersRemoved: 0,
    phoneNumbers: 0,
    inboxes: 0,
    callMinutes: 0,
    tokens: 0,
    tokensBySource: {},
    tokensByDay: Array(days).fill(0),
    byBot: [],
    from: cloud ? "cloud" : "mac",
  };
  const bots = new Map<string, UsageTotals["byBot"][number]>();
  const botRow = (botId: string) => {
    let row = bots.get(botId);
    if (!row) {
      const b = getState().bots.find((x) => x.id === botId);
      row = { botId, name: botId ? (b?.name ?? "Removed bot") : "Not tied to a bot", color: b?.color, tokens: 0, callMinutes: 0, computers: 0 };
      bots.set(botId, row);
    }
    return row;
  };
  const addTokens = (source: TokenSource, n: number, botId: string | null | undefined, day: number) => {
    t.tokens += n;
    t.tokensBySource[source] = (t.tokensBySource[source] ?? 0) + n;
    if (day >= 0 && day < days) t.tokensByDay[day] += n;
    botRow(botId ?? "").tokens += n;
  };
  for (const e of events) {
    const qty = Number(e.qty) || 0;
    // Codex's own tokens, which builds before Deskwisp stopped signing in to Codex kept here: never Deskwisp' to count.
    if (e.kind === "model.tokens" && (e as { plan?: string }).plan) continue;
    if (e.kind === "computer.create") {
      t.computersCreated++;
      if (e.botId) botRow(e.botId).computers++;
    } else if (e.kind === "computer.remove") t.computersRemoved++;
    else if (e.kind === "phone.number") t.phoneNumbers++;
    else if (e.kind === "mail.inbox") t.inboxes++;
    else if (cloud) continue;
    else if (e.kind === "call.minutes") {
      t.callMinutes += qty;
      if (e.botId) botRow(e.botId).callMinutes += qty;
    } else if (e.kind === "model.tokens") {
      const tokens = qty || (Number(e.inputTokens) || 0) + (Number(e.outputTokens) || 0);
      addTokens((e.source as TokenSource | undefined) ?? "other", tokens, e.botId, new Date(e.at).getDate() - 1);
    }
  }
  if (cloud) {
    const parts = new Map<SpendKind, { costMicros: number; amount: number }>();
    for (const k of cloud.kinds) {
      const id = spendKind(k.kind, k.source);
      const part = parts.get(id) ?? { costMicros: 0, amount: 0 };
      part.costMicros += k.costMicros;
      // How much of it, in the part's own unit: tokens, call minutes, or how many (searches, checks, texts, numbers, codes, app runs).
      if (k.kind === "openai.live_seconds" || k.kind === "agentphone.voice_seconds") part.amount += k.units / 60;
      else if (k.kind === "call.minutes") part.amount += k.units;
      else if (k.kind === "openai.tokens") part.amount += id === "call" ? 0 : k.units;
      else if (k.kind !== "honcho.calls") part.amount += k.kind === "openai.web_search" ? k.units : k.count;
      parts.set(id, part);
      if (k.kind === "openai.tokens" || k.kind === "typesafe.tokens") {
        const source: TokenSource = k.kind === "typesafe.tokens" ? "decide" : (TOKEN_SOURCE[k.source ?? ""] ?? "other");
        t.tokensBySource[source] = (t.tokensBySource[source] ?? 0) + k.units;
        t.tokens += k.units;
      }
    }
    t.spend = {
      costMicros: cloud.costMicros,
      charged: cloud.charged === true,
      parts: [...parts]
        .map(([id, p]) => ({ id, ...p }))
        .filter((p) => p.costMicros > 0 || p.amount > 0)
        .sort((a, b) => b.costMicros - a.costMicros || b.amount - a.amount),
    };
    for (const d of cloud.days) {
      const [y, m, day] = d.day.split("-").map(Number);
      if (y === start.getFullYear() && m === start.getMonth() + 1 && day >= 1 && day <= days) t.tokensByDay[day - 1] += d.tokens;
    }
    for (const b of cloud.bots) {
      const row = botRow(b.botId ?? "");
      row.tokens += b.tokens;
      row.callMinutes += b.callSeconds / 60;
      row.costMicros = (row.costMicros ?? 0) + b.costMicros;
      t.callMinutes += b.callSeconds / 60;
    }
  }
  t.callMinutes = Math.round(t.callMinutes * 10) / 10;
  t.byBot = [...bots.values()].sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0) || b.tokens - a.tokens || b.callMinutes - a.callMinutes);
  return t;
}
