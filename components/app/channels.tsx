"use client";

import { useEffect, useMemo, useState } from "react";
import { CHANNELS, PAIR_CODE_MS, PAIR_CODE_TRIES, pairCodeLive, workspaceOf, type AppState, type Bot, type ChannelLink } from "@/lib/types";
import { ConnectAgentPhone } from "./agentphone-connect";
import { Spinner } from "./mascot";
import { BrandTile, post } from "./ui";

/*
 * Where to find a bot: the places it lives besides Deskwisp. One row of tiles; a tile that's set up says
 * where (its @handle, its channels) and whether it's paired. Opening one shows its few steps inline,
 * so setting up Telegram never pushes the profile around more than it has to.
 */

type Kind = "slack" | "telegram" | "discord" | "imessage";

export function WhereToFind({ state, bot: b }: { state: AppState; bot: Bot }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const links = (state.channels ?? []).filter((l) => l.botId === b.id);
  const line = state.workspaces?.find((w) => w.id === workspaceOf(b))?.line;
  const status = (kind: string): { text: string; tone: "live" | "wait" | "error" | "off" } => {
    if (kind === "email") return b.email ? { text: b.email, tone: "live" } : { text: "Its own inbox", tone: "off" };
    if (kind === "imessage") return line ? { text: b.isMain ? pretty(line.phone) : `Through the team's number`, tone: "live" } : { text: "Set up iMessage", tone: "off" };
    const l = links.find((x) => x.kind === kind);
    if (!l) return { text: CHANNELS.find((c) => c.id === kind)!.hint, tone: "off" };
    if (l.status === "error") return { text: "Needs attention", tone: "error" };
    if (!l.owner) return { text: `${where(l)} · pair it`, tone: "wait" };
    return { text: where(l), tone: "live" };
  };
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold leading-4">Where to find {b.name}</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">Add {b.name} like a teammate</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {CHANNELS.map((ch) => {
          const s = status(ch.id);
          const setup = (ch.live && ["slack", "telegram", "discord"].includes(ch.id)) || ch.id === "imessage";
          const soon = !ch.live && ch.id === "whatsapp";
          const body = (
            <>
              <BrandTile item={ch} size={26} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium leading-[18px]">{ch.name.replace(" + SMS", "")}</span>
                  {s.tone !== "off" && <span className={`size-1.5 shrink-0 rounded-full ${s.tone === "live" ? "bg-[#12B76A]" : s.tone === "wait" ? "bg-[#F79009]" : "bg-[#F04438]"}`} />}
                </span>
                <span className="truncate text-[11.5px] leading-[15px] text-[#6B6B6B]">{soon ? "Coming soon" : s.text}</span>
              </span>
            </>
          );
          return setup ? (
            <button
              key={ch.id}
              onClick={() => setOpen(open === ch.id ? null : (ch.id as Kind))}
              className={`flex items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left ${open === ch.id ? "bg-white shadow-[0_0_0_1.5px_#16132B]" : "bg-white/70 shadow-[inset_0_0_0_1px_#E6E6E3] hover:bg-white"}`}
            >
              {body}
            </button>
          ) : (
            <div key={ch.id} className={`flex items-center gap-2.5 rounded-[14px] px-2.5 py-2 ${soon ? "opacity-50" : ""} bg-white/40 shadow-[inset_0_0_0_1px_#ECECEA]`}>
              {body}
            </div>
          );
        })}
      </div>
      {open && <Setup key={open} state={state} bot={b} kind={open} link={links.find((l) => l.kind === open)} />}
    </div>
  );
}

/** +14155550100 → +1 (415) 555-0100 (US numbers; others as they are). */
const pretty = (e164: string) => (/^\+1\d{10}$/.test(e164) ? `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164);

const where = (l: ChannelLink) => (l.kind === "slack" ? (l.slack?.channels.length ? l.slack.channels.map((c) => `#${c.name}`).join(", ") : `DMs in ${l.handle}`) : l.handle);

const card = "flex flex-col gap-3 rounded-[16px] bg-white p-3.5 shadow-[0_0_0_1px_#ECECEA]";
const field = "min-w-0 flex-1 rounded-xl bg-[#F7F7F6] px-3 py-2 font-mono text-[12.5px] leading-[18px] outline-none placeholder:font-sans placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#16132B]";
const primary = "shrink-0 whitespace-nowrap rounded-full bg-ink px-3.5 py-2 text-[12.5px] font-semibold leading-4 text-white hover:bg-[#2A2A28] disabled:opacity-40";
const quiet = "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-medium leading-4 text-[#3A3A38] shadow-[inset_0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]";

function Setup({ state, bot: b, kind, link }: { state: AppState; bot: Bot; kind: Kind; link?: ChannelLink }) {
  if (kind === "imessage") return <ImessageSetup state={state} bot={b} />;
  if (link) return <Linked bot={b} link={link} />;
  if (kind === "slack") return <SlackSetup state={state} bot={b} />;
  return <TokenSetup bot={b} kind={kind} />;
}

type ImLine = { id: string; phone: string; team: string | null };

/**
 * iMessage: the team's number made an iMessage line on the user's own AgentPhone account (AgentPhone
 * bills them for it; lib/server/phone.ts imessageLines). The main bot answers on it, the team's other
 * bots through it. Steps: connect AgentPhone (once), then use a line the account has, or get one there
 * (only receives, or sends too). With a line: which one, and "Stop using it here".
 */
function ImessageSetup({ state, bot: b }: { state: AppState; bot: Bot }) {
  const ws = workspaceOf(b);
  const team = state.workspaces?.find((w) => w.id === ws);
  const main = state.bots.find((x) => x.isMain && workspaceOf(x) === ws);
  const line = team?.line;
  const [asked, setAsked] = useState(0);
  const [phones, setPhones] = useState<{ on: boolean; connect: boolean } | null>(null);
  const [lines, setLines] = useState<ImLine[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [sends, setSends] = useState(true);
  useEffect(() => {
    if (line) return;
    let gone = false;
    void (async () => {
      const st = (await fetch(`/api/phone${asked > 0 ? "?fresh=1" : ""}`, { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null)) as { on?: boolean; connect?: boolean } | null;
      if (gone) return;
      setPhones({ on: !!st?.on, connect: !!st?.connect });
      if (!st?.on) return;
      const res = await fetch("/api/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "imessage-lines" }) }).catch(() => null);
      const j = (await res?.json().catch(() => null)) as { lines?: ImLine[]; error?: string } | null;
      if (gone) return;
      if (!j || j.error || !Array.isArray(j.lines)) {
        setError(j?.error ?? "Couldn't read your AgentPhone account. Try again.");
        setLines([]);
      } else setLines(j.lines);
    })();
    return () => {
      gone = true;
    };
  }, [asked, line]);

  const act = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    setError(null);
    const res = await post("/api/phone", body);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!res.ok || j.error) setError(j.error ?? "That didn't work. Try again.");
    else setAsked((n) => n + 1);
  };

  if (line)
    return (
      <div className={card}>
        <span className="text-[13px] leading-5 text-[#3A3A38]">
          {b.isMain ? (
            <>
              People {line.type === "imessage" ? "iMessage" : "text"} {b.name} at <b>{pretty(line.phone)}</b>, {team?.name ?? "the team"}&apos;s number. {b.name} answers there and hands work to the team.
            </>
          ) : (
            <>
              {b.name} gets messages through {main?.name ?? "the main bot"}, on {team?.name ?? "the team"}&apos;s number <b>{pretty(line.phone)}</b>.
            </>
          )}
        </span>
        {b.isMain && (
          <div className="flex items-center gap-2">
            <button onClick={() => void act("release", { action: "release-line", workspaceId: ws })} disabled={!!busy} className={quiet}>
              {busy === "release" ? "Stopping…" : "Stop using it here"}
            </button>
            <span className="text-[11.5px] leading-4 text-[#9A9A98]">The line stays on your AgentPhone account.</span>
          </div>
        )}
        {error && <span className="text-[12px] text-[#C2410C]">{error}</span>}
      </div>
    );
  if (!b.isMain && main)
    return (
      <div className={card}>
        <span className="text-[13px] leading-5 text-[#3A3A38]">
          iMessage is the team&apos;s: set it up on {main.name} (its Where to find), and {b.name} gets messages through {main.name}.
        </span>
      </div>
    );
  if (!phones)
    return (
      <div className={`${card} flex-row items-center`}>
        <Spinner size={14} />
        <span className="text-[12.5px] text-[#6B6B6B]">Checking…</span>
      </div>
    );
  if (!phones.on)
    return (
      <div className={card}>
        {phones.connect ? (
          <ConnectAgentPhone bot={b} what="imessage" className="" onDone={() => setAsked((n) => n + 1)} />
        ) : (
          <span className="text-[13px] leading-5 text-[#3A3A38]">Sign in to Deskwisp to set up iMessage.</span>
        )}
      </div>
    );

  const free = (lines ?? []).filter((l) => !l.team || l.team === team?.name);
  const taken = (lines ?? []).filter((l) => l.team && l.team !== team?.name);
  return (
    <div className={card}>
      <span className="text-[13px] leading-5 text-[#3A3A38]">
        People iMessage {b.name} on an iMessage line from your AgentPhone account. AgentPhone bills you for the line each month; it costs far more than a regular number (
        <a href="https://agentphone.ai/pricing" target="_blank" rel="noreferrer" className="underline">
          their prices
        </a>
        ).
      </span>
      {lines === null ? (
        <span className="flex items-center gap-2 text-[12.5px] text-[#6B6B6B]">
          <Spinner size={14} /> Looking at your AgentPhone account…
        </span>
      ) : (
        <>
          {free.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-xl bg-[#F7F7F6] px-3 py-2">
              <span className="font-mono text-[12.5px]">{pretty(l.phone)}</span>
              <button onClick={() => void act(l.id, { action: "imessage-use", workspaceId: ws, number: l.phone })} disabled={!!busy} className={primary}>
                {busy === l.id ? "Setting up…" : `Use for ${b.name}`}
              </button>
            </div>
          ))}
          {taken.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 opacity-60 shadow-[inset_0_0_0_1px_#ECECEA]">
              <span className="font-mono text-[12.5px]">{pretty(l.phone)}</span>
              <span className="text-[11.5px] text-[#6B6B6B]">{l.team}&apos;s number</span>
            </div>
          ))}
          {!buying ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-[#6B6B6B]">{free.length ? "Or a new one:" : "No iMessage line on your AgentPhone account yet."}</span>
              <button onClick={() => setBuying(true)} disabled={!!busy} className={quiet}>
                Get an iMessage line
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-xl p-3 shadow-[inset_0_0_0_1px_#E6E6E3]">
              <div role="radiogroup" aria-label="What the line does" className="flex flex-wrap gap-1.5">
                {[
                  { v: true, label: "Sends and receives" },
                  { v: false, label: "Only receives" },
                ].map((o) => (
                  <button
                    key={o.label}
                    role="radio"
                    aria-checked={sends === o.v}
                    onClick={() => setSends(o.v)}
                    disabled={!!busy}
                    className={`rounded-full px-2.5 py-1 text-[12.5px] font-medium leading-4 ${sends === o.v ? "bg-ink text-white" : "text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3] hover:bg-black/[0.04]"}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="text-[11.5px] leading-4 text-[#6B6B6B]">
                {sends ? `${b.name} can start conversations and answer.` : `${b.name} answers people who write first.`} It&apos;s bought on your AgentPhone account, which pays for it every month.
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => void act("buy", { action: "imessage-get", workspaceId: ws, sends })} disabled={!!busy} className={primary}>
                  {busy === "buy" ? "Getting it…" : "Get the line"}
                </button>
                <button onClick={() => setBuying(false)} disabled={!!busy} className="text-[12.5px] text-[#6B6B6B] hover:text-ink">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <span className="text-[12px] text-[#C2410C]">{error}</span>}
    </div>
  );
}

/** Telegram and Discord: make the bot's account there, paste its token. */
function TokenSetup({ bot: b, kind }: { bot: Bot; kind: "telegram" | "discord" }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    const res = await post("/api/channels", { botId: b.id, kind, token });
    const j = (await res.json()) as { error?: string };
    setBusy(false);
    if (j.error) setError(j.error);
  };
  const steps =
    kind === "telegram"
      ? [
          <>
            Open{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium underline">
              @BotFather
            </a>{" "}
            in Telegram and send <Code>/newbot</Code>.
          </>,
          <>
            Name it <b>{b.name}</b>, and pick a username ending in &ldquo;bot&rdquo;.
          </>,
          <>Paste the token BotFather sends you.</>,
        ]
      : [
          <>
            In{" "}
            <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="font-medium underline">
              Discord&rsquo;s developer portal
            </a>
            , make a New Application called <b>{b.name}</b>.
          </>,
          <>
            Under <b>Bot</b>: turn on <b>Message Content Intent</b>, then <b>Reset Token</b>.
          </>,
          <>Paste the token. Deskwisp then gives you the link to add it to your server.</>,
        ];
  return (
    <div className={card}>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[#F2F2F0] text-[10.5px] font-semibold text-[#6B6B6B]">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token.trim() && void add()}
          placeholder={kind === "telegram" ? "123456789:AAH…" : "The bot's token"}
          autoComplete="off"
          className={field}
        />
        <button onClick={() => void add()} disabled={busy || !token.trim()} className={primary}>
          {busy ? "Checking…" : `Add ${b.name}`}
        </button>
      </div>
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      <span className="text-[11.5px] leading-4 text-[#9A9A98]">The token stays encrypted on this PC. {b.name} takes requests only from you there.</span>
    </div>
  );
}

/** Slack: connect the Slack app once (Composio), then pick the channels this bot joins. */
function SlackSetup({ state, bot: b }: { state: AppState; bot: Bot }) {
  const accounts = (state.accounts ?? []).filter((a) => a.app === "slackbot" && a.status === "active");
  const waiting = (state.connecting ?? []).find((c) => c.app === "slackbot");
  const [picked, setAccount] = useState<string>();
  const account = picked && accounts.some((a) => a.id === picked) ? picked : accounts[0]?.id;
  if (!accounts.length)
    return (
      <div className={card}>
        <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">
          Add Deskwisp to your Slack workspace once (Slack asks you to allow it). Then pick the channels {b.name} joins; your other bots join through the same app.
        </span>
        <div className="flex items-center gap-2">
          {waiting?.status === "waiting" ? (
            <span className="flex items-center gap-2 text-[12.5px] text-[#6B6B6B]">
              <Spinner size={13} /> Finish adding it in your browser…
            </span>
          ) : (
            <button onClick={() => void post("/api/apps", { app: "slackbot" })} className={primary}>
              Add to Slack
            </button>
          )}
          {waiting?.status === "failed" && <span className="text-[12px] text-[#B42318]">{waiting.error}</span>}
        </div>
      </div>
    );
  return <SlackChannels bot={b} account={account!} accounts={accounts.map((a) => ({ id: a.id, name: a.label ?? a.name ?? "Slack" }))} onAccount={setAccount} />;
}

function SlackChannels({ bot: b, account, accounts, onAccount, current, onDone }: { bot: Bot; account: string; accounts: { id: string; name: string }[]; onAccount: (id: string) => void; current?: { id: string; name: string }[]; onDone?: () => void }) {
  type Found = { id: string; name: string; private: boolean; member: boolean };
  const [found, setFound] = useState<{ account: string; channels: Found[]; error?: string } | null>(null);
  const all = found?.account === account ? found.channels : null;
  const [saveError, setError] = useState<string | null>(null);
  const error = saveError ?? (found?.account === account ? found.error : undefined) ?? null;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string }[]>(current ?? []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/channels/slack?account=${encodeURIComponent(account)}`)
      .then((r) => r.json() as Promise<{ channels: Found[]; error?: string }>)
      .then((j) => !gone && setFound({ account, channels: j.channels, error: j.error }));
    return () => {
      gone = true;
    };
  }, [account]);
  const shown = useMemo(() => (all ?? []).filter((c) => c.name.includes(q.trim().toLowerCase().replace(/^#/, ""))).slice(0, 80), [all, q]);
  const on = (id: string) => picked.some((c) => c.id === id);
  const save = async () => {
    setBusy(true);
    const res = await post("/api/channels", { botId: b.id, kind: "slack", account, channels: picked });
    const j = (await res.json()) as { error?: string };
    setBusy(false);
    if (j.error) setError(j.error);
    else onDone?.();
  };
  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a channel" className={`${field} font-sans`} />
        {accounts.length > 1 && (
          <select value={account} onChange={(e) => onAccount(e.target.value)} className="rounded-xl bg-[#F7F7F6] px-2 py-2 text-[12.5px] outline-none">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex max-h-[180px] flex-wrap content-start gap-1.5 overflow-y-auto">
        {!all ? (
          <span className="flex items-center gap-2 py-2 text-[12.5px] text-[#9A9A98]">
            <Spinner size={13} /> Loading channels…
          </span>
        ) : (
          shown.map((c) => (
            <button
              key={c.id}
              onClick={() => setPicked(on(c.id) ? picked.filter((x) => x.id !== c.id) : [...picked, { id: c.id, name: c.name }])}
              title={c.private && !c.member ? `Private: invite the app with /invite in #${c.name} first` : undefined}
              className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${on(c.id) ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
            >
              {c.private ? "🔒 " : "#"}
              {c.name}
            </button>
          ))
        )}
      </div>
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button onClick={() => void save()} disabled={busy} className={primary}>
          {busy ? "Joining…" : picked.length ? `Add to ${picked.length} channel${picked.length === 1 ? "" : "s"}` : "Just direct messages"}
        </button>
        <span className="text-[11.5px] leading-4 text-[#9A9A98]">In a channel, {b.name} answers when you mention it by name or reply in its thread.</span>
      </div>
    </div>
  );
}

/** Set up: where it is, how to pair (until it's paired), and taking it out. */
function Linked({ bot: b, link: l }: { bot: Bot; link: ChannelLink }) {
  const [sure, setSure] = useState(false);
  const [editing, setEditing] = useState(false);
  // A code pairs for an hour and stops after a few wrong ones: then it's swapped for a new one here.
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = (l.pairCodeAt ?? l.at) + PAIR_CODE_MS;
  useEffect(() => {
    if (l.owner) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 500);
    return () => clearTimeout(t);
  }, [l.owner, expiresAt]);
  const pairHow = !pairCodeLive(l, now) ? (
    <>
      <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">
        {(l.pairTries ?? 0) >= PAIR_CODE_TRIES ? "Too many wrong codes were sent, so this code stopped working." : "This pairing code expired."}
      </span>
      <button onClick={() => void post("/api/channels", { linkId: l.id }, "PATCH")} className={primary}>
        New code
      </button>
    </>
  ) : l.kind === "telegram" ? (
    <>
      <a href={`https://t.me/${l.telegram?.username}?start=${l.pairCode}`} target="_blank" rel="noreferrer" className={primary}>
        Pair in Telegram
      </a>
      <span className="text-[12px] leading-4 text-[#6B6B6B]">
        Opens {l.handle} and sends it <Code>{l.pairCode}</Code>
      </span>
    </>
  ) : (
    <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">
      Send {l.kind === "slack" ? "the Deskwisp app a direct message" : `${l.handle} a direct message (or mention it in a channel)`} with just the code <Code>{l.pairCode}</Code>
    </span>
  );
  return (
    <div className={card}>
      {l.status === "error" && <span className="rounded-xl bg-[#FFF4F2] px-3 py-2 text-[12.5px] leading-[17px] text-[#B42318]">{l.error}</span>}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">
          <b className="font-semibold">{where(l)}</b>
          <span className="text-[#6B6B6B]">{l.owner ? ` · paired with ${l.ownerName ?? "you"}` : " · not paired yet"}</span>
        </span>
        {l.kind === "discord" && l.discord && (
          <a href={discordInvite(l.discord.appId)} target="_blank" rel="noreferrer" className={quiet}>
            Add to a server
          </a>
        )}
        {l.kind === "slack" && (
          <button onClick={() => setEditing(!editing)} className={quiet}>
            Channels
          </button>
        )}
      </div>
      {editing && l.slack && <SlackChannels bot={b} account={l.slack.accountId} accounts={[]} onAccount={() => {}} current={l.slack.channels} onDone={() => setEditing(false)} />}
      {!l.owner && <div className="flex flex-wrap items-center gap-2.5">{pairHow}</div>}
      <div className="flex items-center gap-2 border-t border-[#F0F0EE] pt-2.5">
        <span className="flex-1 text-[11.5px] leading-4 text-[#9A9A98]">
          {l.owner ? `${b.name} takes requests only from you there. Others are left alone.` : `Pairing tells ${b.name} which account is you. Until then it answers only the code, which works for an hour.`}
        </span>
        {l.owner && (
          <button onClick={() => void post("/api/channels", { linkId: l.id }, "PATCH")} className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#6B6B6B] hover:bg-[#F2F2F0]">
            Pair again
          </button>
        )}
        {sure ? (
          <span className="flex shrink-0 items-center gap-1">
            <button onClick={() => void post("/api/channels", { linkId: l.id }, "DELETE")} className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold text-white">
              Remove
            </button>
            <button onClick={() => setSure(false)} className="rounded-full px-2 py-1 text-[12px] text-[#6B6B6B]">
              Keep
            </button>
          </span>
        ) : (
          <button onClick={() => setSure(true)} className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#B42318] hover:bg-[#FEF3F2]">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** The same link the server builds (lib/server/channels.ts): add the bot to a server with what it needs. */
const discordInvite = (appId: string) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${2 ** 10 + 2 ** 11 + 2 ** 16 + 2 ** 6 + 2 ** 14 + 2 ** 15 + 2 ** 38}`;

const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded-md bg-[#F2F2F0] px-1.5 py-px font-mono text-[12px]">{children}</code>;
