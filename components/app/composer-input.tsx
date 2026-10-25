"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mascot } from "./mascot";
import { openLibrary } from "./library";

/** A bot that can be @mentioned in a composer. */
export type Mentionable = { id: string; name: string; color: string; role?: string; isMain?: boolean };

/** The "@query" being typed right before the caret, if any: where it starts and what's typed after the @. */
function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** The "/query" being typed right before the caret, if any (at the start or after a space). */
function slashAt(text: string, caret: number) {
  const m = /(^|\s)\/([a-z0-9:-]{0,40})$/i.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** What "/" lists: Add files, the skills and commands that are on, and the way to more. */
type SlashItem =
  | { kind: "files" }
  | { kind: "skill" | "command"; id: string; description: string; hint?: string }
  | { kind: "manage"; what: "skills" | "plugins" };
type Menu = { skills: { id: string; name: string; description: string }[]; commands: { id: string; description: string; hint?: string }[] };

/**
 * A message box: Enter sends (submits its form), Shift+Enter starts a new line, and it grows with
 * what's typed, up to about 8 lines, then scrolls. Typing with an input method (e.g. Japanese) never
 * sends mid-composition.
 *
 * `mentions`: the bots in the conversation. Typing @ lists them above the box (narrowing as you type);
 * ↑/↓ move, Enter or Tab puts "@Name " in, Esc closes the list.
 *
 * `slash`: typing / lists Add files (`onAddFiles`), the user's skills and plugin commands (from
 * /api/skills?menu=1, read each time the list opens), and Manage skills and Browse plugins
 * (library.tsx). Picking a skill or command puts "/name " in: the bot gets its instructions with the
 * message (lib/server/skill-library.ts invokedNote).
 */
export function ComposerInput({
  value,
  onChange,
  onKeyDown,
  mentions,
  slash,
  className = "",
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
  mentions?: Mentionable[];
  slash?: { onAddFiles?: () => void };
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  // Fit the height to the text (shrinks again after sending).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const sl = slash ? slashAt(value, Math.min(caret, value.length)) : null;
  const slashOpen = !!sl && dismissed !== sl.start;
  // The skills and commands, read each time the list opens.
  useEffect(() => {
    if (!slashOpen) return;
    let live = true;
    void fetch("/api/skills?menu=1", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Menu>) : null))
      .then((j) => live && j && setMenu(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slashOpen]);
  const sq = sl?.query.toLowerCase() ?? "";
  const slashItems: SlashItem[] = sl
    ? [
        ...(slash?.onAddFiles && (!sq || "add files".includes(sq) || "files".startsWith(sq)) ? [{ kind: "files" as const }] : []),
        ...(menu?.skills ?? [])
          .filter((x) => !sq || x.id.includes(sq) || x.name.toLowerCase().includes(sq) || x.description.toLowerCase().includes(sq))
          .slice(0, 30)
          .map((x) => ({ kind: "skill" as const, id: x.id, description: x.description })),
        ...(menu?.commands ?? [])
          .filter((x) => !sq || x.id.includes(sq) || x.description.toLowerCase().includes(sq))
          .slice(0, 20)
          .map((x) => ({ kind: "command" as const, id: x.id, description: x.description, hint: x.hint })),
        { kind: "manage" as const, what: "skills" as const },
        { kind: "manage" as const, what: "plugins" as const },
      ]
    : [];
  const slashShowing = slashOpen && slashItems.length > 0;
  const slashPick = Math.min(active, slashItems.length - 1);
  /** The "/query" typed, replaced with `put` (nothing for Add files and the way to more). */
  const replaceSlash = (put: string) => {
    if (!sl) return;
    const end = sl.start + 1 + sl.query.length;
    const after = value.slice(end).replace(/^\s/, "");
    const text = `${value.slice(0, sl.start)}${put}${put ? " " : ""}${after}`;
    const pos = sl.start + put.length + (put ? 1 : 0);
    onChange(text);
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  const chooseSlash = (item: SlashItem) => {
    if (item.kind === "files") {
      replaceSlash("");
      slash?.onAddFiles?.();
    } else if (item.kind === "manage") {
      replaceSlash("");
      openLibrary(item.what);
    } else replaceSlash(`/${item.id}`);
  };

  const at = mentions?.length && !slashShowing ? mentionAt(value, Math.min(caret, value.length)) : null;
  const q = at?.query.toLowerCase() ?? "";
  const matches = at
    ? (mentions ?? [])
        .filter((b) => b.name.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
    : [];
  const showing = !!at && dismissed !== at.start && matches.length > 0;
  const pick = Math.min(active, matches.length - 1);

  const choose = (b: Mentionable) => {
    if (!at) return;
    const end = at.start + 1 + at.query.length;
    const after = value.slice(end).replace(/^\s/, "");
    const text = `${value.slice(0, at.start)}@${b.name} ${after}`;
    const pos = at.start + b.name.length + 2;
    onChange(text);
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const track = (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0);

  return (
    <>
      {slashShowing && (
        <div
          role="listbox"
          aria-label="Skills and commands"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[340px] w-[min(380px,100%)] flex-col overflow-y-auto rounded-[16px] bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_16px_40px_-12px_#00000040]"
        >
          {slashItems.map((item, i) => {
            const selected = i === slashPick;
            const first = (k: SlashItem["kind"]) => slashItems.findIndex((x) => x.kind === k) === i;
            return (
              <div key={item.kind === "skill" || item.kind === "command" ? `${item.kind}:${item.id}` : item.kind === "manage" ? `manage:${item.what}` : "files"} className="flex flex-col">
                {item.kind === "skill" && first("skill") && <span className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium leading-4 text-[#9A9A98]">Skills</span>}
                {item.kind === "command" && first("command") && <span className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium leading-4 text-[#9A9A98]">Commands</span>}
                {item.kind === "manage" && first("manage") && <div className="mx-2 my-1 h-px bg-[#ECECEA]" />}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => chooseSlash(item)}
                  className={`flex items-center gap-2.5 rounded-[11px] px-2.5 py-1.5 text-left ${selected ? "bg-[#F2F2F0]" : ""}`}
                >
                  <SlashIcon kind={item.kind} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-medium leading-[18px]">
                      {item.kind === "files" ? "Add files" : item.kind === "manage" ? (item.what === "skills" ? "Manage skills" : "Browse plugins") : `/${item.id}`}
                      {item.kind === "command" && item.hint ? <span className="font-normal text-[#9A9A98]"> {item.hint}</span> : null}
                    </span>
                    {(item.kind === "skill" || item.kind === "command") && <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{item.description}</span>}
                    {item.kind === "files" && <span className="truncate text-[12px] leading-4 text-[#9A9A98]">Any file: documents, sheets, PDFs, pictures</span>}
                  </span>
                  {selected && <span className="shrink-0 text-[11px] text-[#9A9A98]">↵</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {showing && (
        <div
          role="listbox"
          aria-label="Mention a bot"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute bottom-full left-0 right-0 z-30 mb-2 flex max-h-[260px] flex-col overflow-y-auto rounded-[16px] bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_16px_40px_-12px_#00000040]"
        >
          <span className="px-2.5 pb-1 pt-1 text-[11.5px] font-medium leading-4 text-[#9A9A98]">Mention a bot</span>
          {matches.map((b, i) => (
            <button
              key={b.id}
              type="button"
              role="option"
              aria-selected={i === pick}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(b)}
              className={`flex items-center gap-2.5 rounded-[11px] px-2.5 py-1.5 text-left ${i === pick ? "bg-[#F2F2F0]" : ""}`}
            >
              <Mascot botId={b.id} color={b.color} size={26} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-semibold leading-[18px]">@{b.name}</span>
                <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{b.isMain ? "Chief of Staff" : (b.role ?? "")}</span>
              </span>
              {i === pick && <span className="shrink-0 text-[11px] text-[#9A9A98]">↵</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setDismissed(null);
        }}
        onSelect={track}
        onClick={track}
        onBlur={() => setDismissed(sl?.start ?? at?.start ?? null)}
        onFocus={() => setDismissed(null)}
        onKeyDown={(e) => {
          if (slashShowing && !e.nativeEvent.isComposing) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((slashPick + step + slashItems.length) % slashItems.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              chooseSlash(slashItems[slashPick]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(sl!.start);
              return;
            }
          }
          if (showing && !e.nativeEvent.isComposing) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((pick + step + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(matches[pick]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(at!.start);
              return;
            }
          }
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        className={`block max-h-[160px] resize-none overflow-y-auto ${className}`}
        {...rest}
      />
    </>
  );
}

function SlashIcon({ kind }: { kind: SlashItem["kind"] }) {
  return (
    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[8px] bg-[#F4F4F2] text-[#3A3A38]">
      {kind === "files" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M10.6 5.2l-4.4 4.4a1.3 1.3 0 0 0 1.8 1.8l5-5a2.6 2.6 0 0 0-3.7-3.7l-5 5a3.9 3.9 0 0 0 5.5 5.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : kind === "command" ? (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
          <path d="M10.5 2.5l-5 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : kind === "manage" ? (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
          <path d="M3 4.5h10M3 8h10M3 11.5h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M4 1.8h5.2L12.4 5v9.2H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9 2v3.2h3.2M6 8.4h4.2M6 10.9h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
