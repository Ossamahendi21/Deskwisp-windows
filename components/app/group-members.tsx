"use client";

import { useState } from "react";
import type { AppState, Bot, Chat } from "@/lib/types";
import { Mascot } from "./mascot";
import { chatName, CloseButton, post, teamOf } from "./ui";

/**
 * A group's bots, sliding in from the side of its chat (click the group's name at the top): who's in it,
 * each with a button to take it out, and the team's other bots, each with a button to add it. A group
 * keeps at least two bots.
 */
export function GroupMembers({ state, chat: c, onClose, onShowBot }: { state: AppState; chat: Chat; onClose: () => void; onShowBot: (botId: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inGroup = c.botIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const others = teamOf(state).filter((b) => !c.botIds.includes(b.id) && !b.archived);
  const change = async (body: { add?: string; remove?: string }) => {
    setBusy(body.add ?? body.remove ?? null);
    setError(null);
    const res = await post("/api/chats", { chatId: c.id, ...body }, "PATCH").catch(() => null);
    if (!res?.ok) setError(((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "That didn't work. Try again.");
    setBusy(null);
  };
  const last = inGroup.length <= 2;

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-black/[0.12]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="flex h-full w-[340px] max-w-full flex-col bg-white shadow-[-16px_0_40px_-20px_#00000040] duration-200 animate-in slide-in-from-right"
      >
        <div className="flex items-start gap-3 border-b border-[#F0F0EE] px-5 pb-4 pt-5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[17px] font-semibold leading-[22px]">{chatName(c, state.bots)}</span>
            <span className="text-[12.5px] leading-4 text-[#9A9A98]">
              {inGroup.length} bot{inGroup.length === 1 ? "" : "s"} and you
            </span>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
          <section className="flex flex-col gap-1">
            <span className="px-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#9A9A98]">In this group</span>
            <Row
              avatar={
                <span className="flex size-[34px] items-center justify-center rounded-full bg-[#F2F2F0] text-[12px] font-semibold text-[#6B6B6B]">You</span>
              }
              name="You"
              sub="Everyone here sees your messages"
            />
            {inGroup.map((b) => (
              <Row
                key={b.id}
                avatar={<Mascot botId={b.id} color={b.color} size={34} />}
                name={b.name}
                sub={b.isMain ? "Chief of Staff" : b.role}
                onOpen={() => onShowBot(b.id)}
                action={
                  <button
                    onClick={() => void change({ remove: b.id })}
                    disabled={!!busy || last}
                    title={last ? "A group needs at least two bots" : `Take ${b.name} out of the group`}
                    aria-label={`Remove ${b.name} from the group`}
                    className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-[#B42318] shadow-[0_0_0_1px_#F2D6D3] hover:bg-[#FEF3F2] disabled:text-[#C9C9C6] disabled:shadow-[0_0_0_1px_#ECECEA] disabled:hover:bg-transparent"
                  >
                    {busy === b.id ? "…" : "Remove"}
                  </button>
                }
              />
            ))}
          </section>

          <section className="flex flex-col gap-1">
            <span className="px-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#9A9A98]">Add to group</span>
            {others.length === 0 ? (
              <span className="px-2 text-[13px] leading-[18px] text-[#9A9A98]">Every bot on your team is already here. Make another with + New bot.</span>
            ) : (
              others.map((b) => (
                <Row
                  key={b.id}
                  avatar={<Mascot botId={b.id} color={b.color} size={34} />}
                  name={b.name}
                  sub={b.isMain ? "Chief of Staff" : b.role}
                  onOpen={() => onShowBot(b.id)}
                  action={
                    <button
                      onClick={() => void change({ add: b.id })}
                      disabled={!!busy}
                      aria-label={`Add ${b.name} to the group`}
                      className="flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-semibold text-white disabled:opacity-40"
                    >
                      {busy === b.id ? (
                        "…"
                      ) : (
                        <>
                          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
                            <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                          Add
                        </>
                      )}
                    </button>
                  }
                />
              ))
            )}
          </section>
          {error && <span className="px-2 text-[12.5px] leading-4 text-[#B42318]">{error}</span>}
        </div>
      </aside>
    </div>
  );
}

function Row({ avatar, name, sub, action, onOpen }: { avatar: React.ReactNode; name: string; sub?: string; action?: React.ReactNode; onOpen?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-[#F7F7F6]">
      <button type="button" onClick={onOpen} disabled={!onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="shrink-0">{avatar}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-semibold leading-[18px]">{name}</span>
          {sub && <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{sub}</span>}
        </span>
      </button>
      {action}
    </div>
  );
}
