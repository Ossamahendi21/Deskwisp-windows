"use client";

import { useState } from "react";
import { ROLE_MAX, type AppState, type Bot } from "@/lib/types";
import { Mascot } from "./mascot";
import { CloseButton, post } from "./ui";

/**
 * Edit, on the right (right-click a bot or a group in the sidebar → Edit). A bot: its name and what it
 * does. A group: its name, and each of its bots, every one with its own Save.
 */
export type EditTarget = { bot: string } | { group: string };

export function EditPanel({ state, target, onClose }: { state: AppState; target: EditTarget; onClose: () => void }) {
  const group = "group" in target ? state.chats.find((c) => c.id === target.group && c.kind === "group") : undefined;
  const one = "bot" in target ? state.bots.find((b) => b.id === target.bot) : undefined;
  const bots = group ? group.botIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b) : one ? [one] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <PencilIcon size={18} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{group ? "Edit group" : one ? `Edit ${one.name}` : "Edit"}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
              {group ? "Rename the group, and change what each of its bots is called and does." : "Its name, and what it does: the team hands it work that fits."}
            </span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        {!group && !one && <span className="text-[13px] text-[#6B6B6B]">It isn&apos;t there any more.</span>}
        {group && <GroupName key={group.id} chatId={group.id} title={group.title ?? ""} placeholder={bots.map((b) => b.name).join(", ")} />}
        {group && <span className="pt-1 text-[15px] font-semibold leading-5">Bots in this group</span>}
        {bots.map((b) => (
          <BotEditor key={b.id} bot={b} />
        ))}
      </div>
    </div>
  );
}

const field =
  "w-full rounded-[10px] bg-[#F4F4F2] px-3 py-2 text-[14px] leading-5 outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#16132B]";

function BotEditor({ bot: b }: { bot: Bot }) {
  const [name, setName] = useState(b.name);
  const [role, setRole] = useState(b.role);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = name.trim() !== b.name || (!b.isMain && role.replace(/\s+/g, " ").trim() !== b.role);
  const save = async () => {
    setBusy(true);
    setNote(null);
    const body: Record<string, string> = { botId: b.id };
    if (name.trim() !== b.name) body.name = name;
    if (!b.isMain && role.trim() !== b.role) body.role = role;
    const res = await post("/api/bots", body, "PATCH").catch(() => null);
    setBusy(false);
    if (res?.ok) setNote({ ok: true, text: "Saved" });
    else setNote({ ok: false, text: ((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't save it" });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && name.trim() && (b.isMain || role.trim())) void save();
      }}
      className="flex flex-col gap-3 rounded-2xl p-4 shadow-[0_0_0_1px_#ECECEA]"
    >
      <div className="flex items-center gap-3">
        <Mascot botId={b.id} color={b.color} size={36} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold leading-5">{b.name}</span>
          <span className="truncate text-[12.5px] leading-4 text-[#9A9A98]">
            {b.isMain ? "Runs the team" : b.role}
            {b.archived ? " · archived" : ""}
          </span>
        </div>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-[#6B6B6B]">Name</span>
        <input value={name} maxLength={40} onChange={(e) => (setName(e.target.value), setNote(null))} className={field} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-[#6B6B6B]">What it does</span>
        {b.isMain ? (
          <span className="text-[13px] leading-[18px] text-[#6B6B6B]">Chief of staff: it runs the team and hands work to the bot whose role fits.</span>
        ) : (
          <textarea
            value={role}
            maxLength={ROLE_MAX}
            rows={2}
            placeholder="Sales, or: finds leads on LinkedIn and writes to them"
            onChange={(e) => (setRole(e.target.value), setNote(null))}
            className={`${field} resize-none`}
          />
        )}
      </label>
      <div className="flex items-center justify-end gap-3">
        {note && <span className={`text-[12.5px] ${note.ok ? "text-[#067647]" : "text-[#B42318]"}`}>{note.text}</span>}
        <button
          type="submit"
          disabled={busy || !changed || !name.trim() || (!b.isMain && !role.trim())}
          className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-30"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function GroupName({ chatId, title, placeholder }: { chatId: string; title: string; placeholder: string }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = value.trim() !== title;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!changed) return;
        setBusy(true);
        const res = await post("/api/chats", { chatId, title: value }, "PATCH").catch(() => null);
        setBusy(false);
        setSaved(!!res?.ok);
      }}
      className="flex flex-col gap-1.5 rounded-2xl p-4 shadow-[0_0_0_1px_#ECECEA]"
    >
      <span className="text-[12.5px] font-medium text-[#6B6B6B]">Group name</span>
      <div className="flex items-center gap-2">
        <input value={value} maxLength={60} placeholder={placeholder} onChange={(e) => (setValue(e.target.value), setSaved(false))} className={field} />
        <button type="submit" disabled={busy || !changed} className="shrink-0 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-30">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {saved && <span className="text-[12.5px] text-[#067647]">Saved</span>}
    </form>
  );
}

export function PencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0">
      <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12 3 13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
