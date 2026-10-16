"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Mascot } from "./mascot";

/** A bot that can be @mentioned in a composer. */
export type Mentionable = { id: string; name: string; color: string; role?: string; isMain?: boolean };

/** The "@query" being typed right before the caret, if any: where it starts and what's typed after the @. */
function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/**
 * A message box: Enter sends (submits its form), Shift+Enter starts a new line, and it grows with
 * what's typed, up to about 8 lines, then scrolls. Typing with an input method (e.g. Japanese) never
 * sends mid-composition.
 *
 * `mentions`: the bots in the conversation. Typing @ lists them above the box (narrowing as you type);
 * ↑/↓ move, Enter or Tab puts "@Name " in, Esc closes the list.
 */
export function ComposerInput({
  value,
  onChange,
  onKeyDown,
  mentions,
  className = "",
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & { value: string; onChange: (value: string) => void; mentions?: Mentionable[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Fit the height to the text (shrinks again after sending).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const at = mentions?.length ? mentionAt(value, Math.min(caret, value.length)) : null;
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
        onBlur={() => setDismissed(at?.start ?? null)}
        onFocus={() => setDismissed(null)}
        onKeyDown={(e) => {
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
