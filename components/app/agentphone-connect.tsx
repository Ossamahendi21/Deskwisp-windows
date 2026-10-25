"use client";

import { useEffect, useState } from "react";
import type { Bot } from "@/lib/types";

/**
 * Phone numbers and iMessage lines come from AgentPhone, on the user's own account: they sign up there,
 * pay AgentPhone for their numbers, calls and texts, and paste their API key here (Deskwisp Cloud checks
 * it with AgentPhone and keeps it sealed: cloud/phone-key.ts). Then "Get a number" (a bot's details) or
 * the iMessage setup (Where to find, lib channels.tsx) appears in its place. `what` says which it's for.
 */
export function ConnectAgentPhone({
  bot: b,
  onDone,
  what = "number",
  className = "px-4 pb-[11px]",
}: {
  /** The bot it's for; Settings' "Your mobile" (`what` "mobile") is for every bot. */
  bot?: Bot;
  onDone: () => void;
  what?: "number" | "imessage" | "mobile";
  className?: string;
}) {
  const name = b?.name ?? "your bots";
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signup, setSignup] = useState("https://agentphone.ai");
  useEffect(() => {
    if (!open) return;
    void fetch("/api/phone/key", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { signup?: string }) => j.signup && /^https:\/\//.test(j.signup) && setSignup(j.signup))
      .catch(() => {});
  }, [open]);
  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/phone/key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: key.trim() }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { connected?: boolean; error?: string } | null;
    setBusy(false);
    if (!res?.ok || !j?.connected) return setError(j?.error ?? "Couldn't connect AgentPhone. Try again.");
    setKey("");
    onDone();
  };
  if (!open)
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <button onClick={() => setOpen(true)} data-tip="Numbers come from AgentPhone, on your own account." className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
          {what === "number" && b ? `Get ${b.name} a number` : "Connect AgentPhone"}
        </button>
      </div>
    );
  return (
    <div className={`flex flex-col gap-2 text-[12px] leading-4 ${className}`}>
      <span className="text-[#3A3A38]">
        {what === "imessage"
          ? `iMessage comes from AgentPhone, on your own account: you pay AgentPhone for the iMessage line, and ${name} answers on it here.`
          : what === "mobile"
            ? "Your bots' numbers come from AgentPhone, on your own account: you pay AgentPhone for each number, its calls and its texts. US and Canadian numbers."
            : `${name}'s numbers come from AgentPhone, on your own account: you pay AgentPhone for each number, its calls and its texts, and ${name} uses them here. US and Canadian numbers.`}
      </span>
      <ol className="flex list-decimal flex-col gap-1 pl-4 text-[#3A3A38]">
        <li>
          <button onClick={() => window.open(signup)} className="font-medium text-ink underline underline-offset-2">
            Sign up at AgentPhone
          </button>{" "}
          and add a payment method.
        </li>
        <li>Create an API key there, and paste it here.</li>
      </ol>
      <div className="flex items-center gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && !busy && void connect()}
          disabled={busy}
          type="password"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="AgentPhone API key"
          aria-label="AgentPhone API key"
          className="h-7 min-w-0 flex-1 rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#16132B] disabled:opacity-50"
        />
        <button onClick={() => void connect()} disabled={busy || !key.trim()} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-50">
          {busy ? "Checking…" : "Connect"}
        </button>
        <button onClick={() => (setOpen(false), setError(null))} disabled={busy} className="shrink-0 text-[12.5px] text-[#6B6B6B] hover:text-ink">
          Cancel
        </button>
      </div>
      {error && <span className="text-[#C2410C]">{error}</span>}
    </div>
  );
}
