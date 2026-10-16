"use client";

import { useEffect, useState } from "react";
import { DESKWISP_TIERS } from "@/cloud/protocol";
import type { DeskwispPlan } from "@/lib/account";
import type { AppState } from "@/lib/types";

/**
 * Over the composer, what the AI credit means for the bots right now, in the way that keeps the work
 * going: a few words when this month's is nearly used (LowCredit), and once it's out (OutOfCredit),
 * that the bots pick up right where they stopped after an upgrade (lib/server/sessions.ts
 * resumeCreditStopped), or when it resets.
 */

/** The Deskwisp plan with its credit (GET /api/plan), read when this shows, when the app comes back to the front, and as the bots answer (at most once a minute). */
function useDeskwispPlan(state: AppState) {
  const [plan, setPlan] = useState<DeskwispPlan | null>(null);
  const [at, setAt] = useState(0);
  const answers = state.messages.filter((m) => m.role === "bot").length;
  useEffect(() => {
    if (Date.now() - at < 60_000 && plan) return;
    let stop = false;
    void fetch("/api/plan?credit=1", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ deskwisp?: DeskwispPlan | null }>) : null))
      .then((j) => {
        if (stop || !j) return;
        setPlan(j.deskwisp ?? null);
        setAt(Date.now());
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, state.credits?.out]);
  useEffect(() => {
    const fresh = () =>
      void fetch("/api/plan?fresh=1", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ deskwisp?: DeskwispPlan | null }>) : null))
        .then((j) => j && setPlan(j.deskwisp ?? null))
        .catch(() => {});
    window.addEventListener("focus", fresh);
    return () => window.removeEventListener("focus", fresh);
  }, []);
  return plan;
}

const dollars = (micros: number) => `$${(Math.max(0, micros) / 1e6).toFixed(2)}`;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const nextUp = (tier: DeskwispPlan["tier"]) => (tier === "free_deskwisp" ? "pro_deskwisp" : tier === "pro_deskwisp" ? "max_deskwisp" : null);

export function CreditBanners({ state, onUpgrade }: { state: AppState; onUpgrade?: () => void }) {
  const plan = useDeskwispPlan(state);
  const [dismissed, setDismissed] = useState(false);
  const c = plan?.credit;
  const up = plan ? nextUp(plan.tier) : null;
  const more = up ? `${DESKWISP_TIERS[up].name} gives your bots ${dollars(DESKWISP_TIERS[up].creditMicros).replace(".00", "")} of AI credit a month.` : "";
  const resets = c?.resetsAt ? ` It resets ${day(c.resetsAt)}.` : "";

  if (state.credits?.out || (c && c.leftMicros <= 0))
    return (
      <Banner
        text={`You've used this month's AI credit, so your bots are paused.${up ? ` Upgrade and they pick up right where they stopped. ${more}` : resets}`}
        onUpgrade={up ? onUpgrade : undefined}
        strong
      />
    );
  if (!plan || !c || dismissed) return null;
  const month = DESKWISP_TIERS[plan.tier].creditMicros;
  if (c.leftMicros >= month * 0.2) return null;
  return (
    <Banner
      text={`${dollars(c.leftMicros)} of AI credit left this month.${up ? ` Upgrade so your bots don't stop halfway. ${more}` : resets}`}
      onUpgrade={up ? onUpgrade : undefined}
      onClose={() => setDismissed(true)}
    />
  );
}

function Banner({ text, onUpgrade, onClose, strong }: { text: string; onUpgrade?: () => void; onClose?: () => void; strong?: boolean }) {
  return (
    <div className={`mb-2.5 flex items-center gap-3 rounded-[16px] px-3.5 py-2.5 ${strong ? "bg-white shadow-[0_0_0_1px_#E2E2DF]" : "bg-[#F7F6FF] shadow-[0_0_0_1px_#E4E0FA]"}`}>
      <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#3A3A38]">{text}</span>
      {onUpgrade && (
        <button onClick={onUpgrade} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
          Upgrade
        </button>
      )}
      {onClose && (
        <button onClick={onClose} aria-label="Hide" className="flex size-6 shrink-0 items-center justify-center rounded-full text-[#9A9A98] hover:bg-black/[0.05] hover:text-ink">
          <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
