"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MAIN_COLOR, mascotMarkup } from "@/lib/mascot";
import { Spinner } from "./mascot";
import { CloseButton } from "./ui";

/*
 * About Deskwisp, from the account menu (sidebar.tsx, above Restart Deskwisp): which version this is and
 * what it runs on; Updates, where you check for a new version, bring it down and restart into it, and
 * choose whether new versions come down by themselves (desktop/win-update.cjs, through the PC app's
 * bridge, desktop/preload.cjs); help (the website, support, the logs, the app's details to paste into a
 * support email); the privacy policy and terms. In a browser, or
 * the Mac app, the Updates part says what it can and the rest is the same.
 */

type Status = {
  current: string;
  state: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error" | "installing" | "off";
  version?: string;
  notes?: string[];
  currentNotes?: string[];
  progress?: number;
  error?: string;
  checkedAt?: number;
  auto?: boolean;
  reason?: "source" | "turned-off" | "store";
};
type About = {
  version: string;
  packaged?: boolean;
  platform: string;
  arch: string;
  os?: string;
  electron?: string;
  chrome?: string;
  node?: string;
};
type Bridge = {
  about?: () => Promise<About>;
  startup?: { logs?: () => Promise<void> };
  update?: {
    status?: () => Promise<Status>;
    onStatus?: (fn: (s: Status) => void) => () => void;
    check?: () => Promise<Status>;
    get?: () => Promise<Status>;
    install?: () => Promise<boolean>;
    setAuto?: (on: boolean) => Promise<Status>;
  };
};
const bridge = () => (window as unknown as { deskwispMac?: Bridge }).deskwispMac;

const SITE = "https://deskwisp.com";
const SUPPORT = "hello@deskwisp.com";
/** "Checked just now." / "Checked 5 minutes ago." / "Checked on 19 Oct." */
function checkedLine(at: number | undefined, now: number) {
  if (!at) return "";
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "Checked just now.";
  if (m < 60) return `Checked ${m} minute${m === 1 ? "" : "s"} ago.`;
  const h = Math.round(m / 60);
  if (h < 24) return `Checked ${h} hour${h === 1 ? "" : "s"} ago.`;
  return `Checked on ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.`;
}
const archName = (a: string) => (a === "x64" ? "64-bit" : a === "arm64" ? "ARM64" : a === "ia32" ? "32-bit" : a);

/** The "About Deskwisp" item's icon: an i in a circle. */
export function AboutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="#16132B" strokeWidth="1.4" />
      <path d="M8 7.3v3.9" fill="none" stroke="#16132B" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r=".95" fill="#16132B" />
    </svg>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const webVersion = process.env.DESKWISP_APP_VERSION ?? "";
  // Opened by a click, so in the browser: what there is to ask is known at once.
  const [about, setAbout] = useState<About | null>(() => (bridge()?.about ? null : { version: webVersion, platform: "Web", arch: "" }));
  const [status, setStatus] = useState<Status | null>(null);
  // No updater to ask: a browser, or a PC app from before About.
  const [noUpdater, setNoUpdater] = useState(() => !bridge()?.update?.status || !bridge()?.update?.onStatus);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const b = bridge();
    let stop = false;
    if (b?.about)
      void b
        .about()
        .then((a) => !stop && setAbout(a))
        .catch(() => !stop && setAbout({ version: webVersion, platform: "Windows", arch: "" }));
    const u = b?.update;
    if (!u?.status || !u.onStatus) return;
    void u
      .status()
      .then((s) => !stop && setStatus(s))
      .catch(() => !stop && setNoUpdater(true));
    const off = u.onStatus((s) => !stop && setStatus(s));
    return () => {
      stop = true;
      off();
    };
  }, [webVersion]);

  useEffect(() => {
    // Escape closes About (and nothing under it).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const version = about?.version || status?.current || "";
  const details = about
    ? [
        `Deskwisp ${version || "(unknown version)"}`,
        about.platform + (about.arch ? ` ${archName(about.arch)}` : ""),
        about.os ? `OS ${about.os}` : "",
        about.electron ? `Electron ${about.electron}` : "",
        about.chrome ? `Chrome ${about.chrome}` : "",
        about.node ? `Node ${about.node}` : "",
        about.packaged === false ? "from source" : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/20 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(720px,calc(100vh-32px))] w-[440px] max-w-full flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <>
          <div className="flex items-start gap-3.5 px-5 pb-4 pt-5">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-[16px] bg-[#F2F2F0]">
              <svg viewBox="0 0 40 40" width="36" height="36" aria-hidden dangerouslySetInnerHTML={{ __html: mascotMarkup("wispy", MAIN_COLOR) }} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col pt-1">
              <span id="about-title" className="text-[17px] font-semibold leading-[22px] tracking-[-0.01em]">
                Deskwisp
              </span>
              <span className="text-[13px] leading-[18px] text-[#6B6B6B]">
                {version ? `Version ${version}` : "Version"}
                {about?.arch ? ` · ${about.platform} ${archName(about.arch)}` : about?.platform === "Web" ? " · in your browser" : ""}
              </span>
            </div>
            <CloseButton onClick={onClose} />
          </div>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5">
            <Section title="Updates">
              <Updates status={status} noUpdater={noUpdater} />
            </Section>

            <Section title="Help">
              <Row label="Website">
                <ExternalLink href={SITE}>deskwisp.com</ExternalLink>
              </Row>
              <Row label="Help and support">
                <ExternalLink href={`mailto:${SUPPORT}?subject=${encodeURIComponent("Deskwisp help")}&body=${encodeURIComponent(`\n\n—\n${details}`)}`}>{SUPPORT}</ExternalLink>
              </Row>
              {bridge()?.startup?.logs && (
                <Row label="Logs" hint="What Deskwisp wrote down, for support">
                  <SmallButton onClick={() => void bridge()?.startup?.logs?.()}>Open folder</SmallButton>
                </Row>
              )}
              <Row label="App details" hint={details || undefined}>
                <SmallButton onClick={() => void copy()} disabled={!details}>
                  {copied ? "Copied" : "Copy"}
                </SmallButton>
              </Row>
            </Section>

            <Section title="Legal">
              <Row label="Privacy policy">
                <ExternalLink href={`${SITE}/privacy`}>Read</ExternalLink>
              </Row>
              <Row label="Terms of service">
                <ExternalLink href={`${SITE}/terms`}>Read</ExternalLink>
              </Row>
            </Section>

            <p className="m-0 text-center text-[11.5px] leading-[16px] text-[#9A9A98]">
              © {new Date().getFullYear()} Deskwisp
            </p>
          </div>
        </>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="m-0 px-1 pb-1.5 text-[12px] font-semibold uppercase leading-4 tracking-[0.04em] text-[#9A9A98]">{title}</h3>
      <div className="flex flex-col rounded-[14px] bg-[#F7F7F6] p-1">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-1.5 [&+&]:border-t [&+&]:border-[#ECECEA]">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13.5px] font-medium leading-[18px]">{label}</span>
        {hint && (
          <span className="truncate text-[11.5px] leading-4 text-[#9A9A98]" title={hint}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[13px] leading-4 text-[#6B6B6B] hover:bg-black/[0.04] hover:text-ink"
    >
      {children}
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M3.5 2h4.5v4.5M8 2L2.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

function SmallButton({ onClick, disabled, primary, children }: { onClick: () => void; disabled?: boolean; primary?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50 ${
        primary ? "bg-ink text-white hover:bg-[#2A2A28]" : "bg-white text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"
      }`}
    >
      {children}
    </button>
  );
}

/** The state of updates in a word or two, with its mark. */
function Headline({ tone, children }: { tone: "ok" | "new" | "busy" | "bad" | "plain"; children: React.ReactNode }) {
  const mark =
    tone === "ok" ? (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
        <circle cx="8" cy="8" r="7" fill="#1F9D55" />
        <path d="M4.8 8.2l2.1 2.1 4.3-4.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : tone === "new" ? (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="shrink-0">
        <path d="M12 2c.7 4.6 2.6 6.6 7.2 7.2-4.6.7-6.5 2.6-7.2 7.2-.7-4.6-2.6-6.5-7.2-7.2C9.4 8.6 11.3 6.6 12 2z" fill="#7C5CFF" />
      </svg>
    ) : tone === "busy" ? (
      <Spinner size={14} />
    ) : tone === "bad" ? (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
        <circle cx="8" cy="8" r="7" fill="#B42318" />
        <path d="M8 4.6v4.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.2" r=".95" fill="#fff" />
      </svg>
    ) : null;
  return (
    <span className="flex items-center gap-2 text-[13.5px] font-medium leading-[18px]">
      {mark}
      {children}
    </span>
  );
}

function Notes({ title, notes }: { title: string; notes?: string[] }) {
  if (!notes?.length) return null;
  return (
    <div className="mt-2.5">
      <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">{title}</span>
      <ul aria-label={title} className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
        {notes.map((n, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-[17px] text-[#3A3A38]">
            <span aria-hidden className="mt-[7px] size-[4px] shrink-0 rounded-full bg-[#7C5CFF]" />
            <span className="min-w-0">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Updates: where they're at, the one thing to do next, and whether they come down by themselves. */
function Updates({ status: s, noUpdater }: { status: Status | null; noUpdater: boolean }) {
  const u = bridge()?.update;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const run = (fn?: () => Promise<unknown>) => async () => {
    if (!fn) return;
    setBusy(true);
    try {
      await fn();
    } catch {
    } finally {
      setBusy(false);
    }
  };

  if (noUpdater) {
    const inBrowser = !bridge();
    return (
      <div className="px-3 py-3">
        <span className="text-[13px] leading-[18px] text-[#6B6B6B]">
          {inBrowser ? "Updates come with the Deskwisp app for Windows: it keeps itself up to date." : "When a new version is out, Deskwisp says so in the sidebar."}
        </span>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="flex min-h-[64px] items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (s.state === "off") {
    return (
      <div className="px-3 py-3">
        <Headline tone="plain">{s.reason === "store" ? "Updates come from the Microsoft Store" : "Updates are off"}</Headline>
        <p className="m-0 mt-1 text-[12.5px] leading-[17px] text-[#6B6B6B]">
          {s.reason === "store"
            ? "The Store keeps this Deskwisp up to date by itself."
            : s.reason === "source"
              ? "This Deskwisp runs from its source folder, so it's as new as the source."
              : "DESKWISP_UPDATES=0 turns them off on this PC."}
        </p>
      </div>
    );
  }

  const checked = checkedLine(s.checkedAt, now);
  let head: React.ReactNode;
  let line: React.ReactNode = null;
  let action: React.ReactNode = null;
  let notes: React.ReactNode = null;
  switch (s.state) {
    case "idle":
      head = <Headline tone="plain">Is there a new version?</Headline>;
      line = "Deskwisp also checks by itself every hour.";
      action = (
        <SmallButton onClick={run(u?.check)} disabled={busy}>
          Check for updates
        </SmallButton>
      );
      break;
    case "checking":
      head = <Headline tone="busy">Checking for updates…</Headline>;
      action = (
        <SmallButton onClick={() => {}} disabled>
          Checking…
        </SmallButton>
      );
      break;
    case "latest":
      head = <Headline tone="ok">Deskwisp is up to date</Headline>;
      line = `${s.current} is the newest version. ${checked}`;
      action = (
        <SmallButton onClick={run(u?.check)} disabled={busy}>
          Check again
        </SmallButton>
      );
      notes = <Notes title={`What's new in ${s.current}`} notes={s.currentNotes} />;
      break;
    case "available":
      head = <Headline tone="new">Deskwisp {s.version} is available</Headline>;
      line = `You have ${s.current}.`;
      action = (
        <SmallButton primary onClick={run(u?.get)} disabled={busy}>
          Download
        </SmallButton>
      );
      notes = <Notes title="What's new" notes={s.notes} />;
      break;
    case "downloading": {
      const pct = Math.round((s.progress ?? 0) * 100);
      head = <Headline tone="busy">Downloading Deskwisp {s.version}…</Headline>;
      line = (
        <span className="mt-2 flex items-center gap-2.5">
          <span
            className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[#E4E4E1]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Download"
          >
            <span className="absolute inset-y-0 left-0 rounded-full bg-[#7C5CFF] transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </span>
          <span className="w-9 text-right text-[12px] tabular-nums text-[#6B6B6B]">{pct}%</span>
        </span>
      );
      notes = <Notes title="What's new" notes={s.notes} />;
      break;
    }
    case "ready":
      head = <Headline tone="new">Deskwisp {s.version} is ready</Headline>;
      line = "Restart to finish. It takes a few seconds, and your bots and chats are saved first.";
      action = (
        <SmallButton primary onClick={run(u?.install)} disabled={busy}>
          Restart to update
        </SmallButton>
      );
      notes = <Notes title="What's new" notes={s.notes} />;
      break;
    case "installing":
      head = <Headline tone="busy">Updating Deskwisp…</Headline>;
      break;
    case "error":
      head = <Headline tone="bad">{s.version ? `Deskwisp ${s.version} didn't download` : "Couldn't check for updates"}</Headline>;
      line = (
        <>
          {s.error ?? "Something went wrong."}{" "}
          <a href={`${SITE}/download/Deskwisp-Setup.exe`} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Get it from deskwisp.com
          </a>
        </>
      );
      action = (
        <SmallButton onClick={run(s.version ? u?.get : u?.check)} disabled={busy}>
          Try again
        </SmallButton>
      );
      break;
  }

  return (
    <>
      <div className="flex flex-col px-3 py-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            {head}
            {line && <div className="mt-0.5 text-[12.5px] leading-[17px] text-[#6B6B6B]">{line}</div>}
          </div>
          {action}
        </div>
        {notes}
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-[#ECECEA] px-3 py-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13.5px] font-medium leading-[18px]">Download updates automatically</span>
          <span className="text-[11.5px] leading-4 text-[#9A9A98]">You choose when to restart.</span>
        </span>
        <Toggle on={s.auto !== false} onChange={(on) => void u?.setAuto?.(on)} />
      </label>
    </>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label="Download updates automatically"
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${on ? "bg-ink" : "bg-[#D6D6D3]"}`}
    >
      <span
        className={`absolute left-0 top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-transform ${on ? "translate-x-[19px]" : "translate-x-[3px]"}`}
      />
    </button>
  );
}
