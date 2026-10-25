"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Skills and Plugins (the You menu, or "/" in a chat): what the user's bots know how to do, beyond
 * what they came with. Yours lists what's added, each on or off, opened to read (and, for the user's
 * own skills, to change); Discover lists the libraries on GitHub (lib/server/skill-catalog.ts) with a
 * search and "+" to add one. Add: upload a skill or a plugin (a SKILL.md or a .zip), create a skill
 * (a name, what it's for, its instructions), or add a GitHub repository as a library.
 * Opened from anywhere with openLibrary("skills" | "plugins").
 */

export type LibraryKind = "skills" | "plugins";
type Tab = "yours" | "discover";
const EVENT = "deskwisp:library";

/** Open Skills or Plugins (DeskwispApp shows it), on Yours or Discover. */
export const openLibrary = (kind: LibraryKind, tab: Tab = "yours") => window.dispatchEvent(new CustomEvent(EVENT, { detail: { kind, tab } }));

/** Which of the two is open, for DeskwispApp. */
export function useLibraryOpen() {
  const [open, setOpen] = useState<{ kind: LibraryKind; tab: Tab } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<{ kind: LibraryKind; tab: Tab }>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [open, setOpen] as const;
}

type Source = { kind: "created" } | { kind: "uploaded"; file: string } | { kind: "library"; repo: string; path: string; ref?: string; library?: string };
type Skill = { id: string; name: string; description: string; enabled: boolean; plugin?: string; source: Source; addedAt: number; license?: string };
type SkillFull = Skill & { body: string; files: string[] };
type Plugin = { name: string; description: string; version?: string; author?: string; enabled: boolean; source: Source; marketplace?: string; addedAt: number; skills: string[]; commands: string[]; unused: string[] };
type LibraryState = { id: string; repo: string; name: string; builtIn?: boolean; only?: LibraryKind; error?: string; skills: number; plugins: number; fetchedAt?: number };
type CatSkill = { library: string; libraryName: string; folder: string; name: string; description: string; license?: string; added: boolean };
type CatPlugin = { library: string; libraryName: string; folder: string; name: string; description: string; category?: string; author?: string; skills: number; commands: number; unused: string[]; added: boolean };
type Catalog = { libraries: LibraryState[]; skills: CatSkill[]; plugins: CatPlugin[] };

async function call<T>(url: string, init?: RequestInit): Promise<T & { error?: string }> {
  const res = await fetch(url, { cache: "no-store", ...init }).catch(() => null);
  const j = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res || !j) return { error: "Couldn't reach Deskwisp. Try again." } as T & { error?: string };
  if (!res.ok && !j.error) return { ...j, error: "That didn't work. Try again." };
  return j;
}
const send = <T,>(url: string, body: unknown) => call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const sourceWords = (s: Source, plugin?: string) =>
  plugin ? `from the ${plugin} plugin` : s.kind === "created" ? "by you" : s.kind === "uploaded" ? `uploaded${s.file ? ` (${s.file})` : ""}` : `from ${s.repo}`;
const ago = (t: number) => {
  const d = Math.round((Date.now() - t) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const field = "w-full rounded-[12px] bg-white px-3 py-2 text-[13px] leading-[18px] outline-none shadow-[0_0_0_1px_#E2E2DF] focus:shadow-[0_0_0_1.5px_#16132B] disabled:opacity-60";
const darkButton = "rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-40";
const lightButton = "rounded-full bg-[#F2F2F0] px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-ink hover:bg-[#EAEAE7] disabled:opacity-40";

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-ink" : "bg-[#E2E2DF]"}`}
    >
      <span className={`absolute top-[3px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-[left] ${on ? "left-[17px]" : "left-[3px]"}`} />
    </button>
  );
}

function Icon({ kind, size = 30 }: { kind: "skill" | "plugin" | "command"; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F2] text-[#3A3A38] shadow-[0_0_0_1px_#ECECEA]" style={{ width: size, height: size }}>
      {kind === "plugin" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M6 1.8v3M10 1.8v3M3.8 4.8h8.4v3.4a4.2 4.2 0 0 1-8.4 0zM8 12.4v1.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : kind === "command" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M10.5 2.5l-5 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 py-px text-[10.5px] font-medium leading-[15px] text-[#6B6B6B]">{children}</span>;
}

/** The dialog. `kind` and `tab` say where it opens. */
export function LibraryDialog({ kind, tab: firstTab, onClose }: { kind: LibraryKind; tab: Tab; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(firstTab);
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // What fills the dialog instead of the list: a skill opened, Create a skill, Add from GitHub.
  const [page, setPage] = useState<{ kind: "skill"; id: string } | { kind: "plugin"; name: string } | { kind: "create" } | { kind: "github" } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const readMine = useCallback(async () => {
    const [s, p] = await Promise.all([call<{ skills: Skill[] }>("/api/skills"), call<{ plugins: Plugin[] }>("/api/plugins")]);
    if (s.error || p.error) setError(s.error ?? p.error ?? null);
    if (s.skills) setSkills(s.skills);
    if (p.plugins) setPlugins(p.plugins);
  }, []);
  const readCatalog = useCallback(async (refresh = false) => {
    setLoadingCatalog(true);
    const c = await call<Catalog>(`/api/library${refresh ? "?refresh=1" : ""}`);
    setLoadingCatalog(false);
    if (c.error) return setError(c.error);
    setCatalog(c);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void readMine(), 0);
    return () => clearTimeout(t);
  }, [readMine]);
  useEffect(() => {
    if (tab !== "discover" || catalog || loadingCatalog) return;
    const t = setTimeout(() => void readCatalog(), 0);
    return () => clearTimeout(t);
  }, [tab, catalog, loadingCatalog, readCatalog]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (menu) setMenu(false);
      else if (page) setPage(null);
      else onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [menu, page, onClose]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  const q = query.trim().toLowerCase();
  const match = (...words: (string | undefined)[]) => !q || words.some((w) => w?.toLowerCase().includes(q));

  const upload = async (file: File) => {
    setError(null);
    setBusy("upload");
    const form = new FormData();
    form.append("file", file);
    const r = await call<{ addedSkills?: string[]; plugin?: string }>("/api/skills", { method: "POST", body: form });
    setBusy(null);
    if (r.error) return setError(r.error);
    setNote(r.plugin ? `Added the ${r.plugin} plugin.` : `Added ${(r.addedSkills ?? []).join(", ")}.`);
    if (r.plugin && kind === "skills") setNote(`That was a plugin: added ${r.plugin} to Plugins, with its skills.`);
    setTab("yours");
    setCatalog(null);
    await readMine();
  };

  const toggleSkill = async (s: Skill, on: boolean) => {
    setBusy(s.id);
    const r = await send<{ skills: Skill[] }>("/api/skills", { action: "toggle", id: s.id, enabled: on });
    setBusy(null);
    if (r.error) return setError(r.error);
    setSkills(r.skills);
    if (s.plugin) await readMine();
  };
  const togglePlugin = async (p: Plugin, on: boolean) => {
    setBusy(p.name);
    const r = await send<{ plugins: Plugin[] }>("/api/plugins", { action: "toggle", name: p.name, enabled: on });
    setBusy(null);
    if (r.error) return setError(r.error);
    await readMine();
  };
  const addSkill = async (c: CatSkill) => {
    const key = `${c.library}|${c.folder}`;
    setBusy(key);
    setError(null);
    const r = await send<{ id: string; skills: Skill[] }>("/api/library", { action: "add-skill", library: c.library, folder: c.folder });
    setBusy(null);
    if (r.error) return setError(r.error);
    setSkills(r.skills);
    setNote(`Added ${r.id}. Your bots use it when a job fits, or when you type /${r.id} in a chat.`);
    setCatalog((x) => x && { ...x, skills: x.skills.map((s) => (s.library === c.library && s.folder === c.folder ? { ...s, added: true } : s)) });
  };
  const addPlugin = async (c: CatPlugin) => {
    const key = `${c.library}|${c.folder}`;
    setBusy(key);
    setError(null);
    const r = await send<{ name: string; plugins: Plugin[] }>("/api/library", { action: "add-plugin", library: c.library, folder: c.folder });
    setBusy(null);
    if (r.error) return setError(r.error);
    setPlugins(r.plugins);
    setNote(`Added the ${r.name} plugin: its skills and commands are on.`);
    setCatalog((x) => x && { ...x, plugins: x.plugins.map((p) => (p.library === c.library && p.folder === c.folder ? { ...p, added: true } : p)) });
  };

  const title = kind === "skills" ? "Skills" : "Plugins";
  const mineSkills = (skills ?? []).filter((s) => match(s.id, s.name, s.description));
  const ownSkills = mineSkills.filter((s) => !s.plugin);
  const pluginSkills = mineSkills.filter((s) => s.plugin);
  const minePlugins = (plugins ?? []).filter((p) => match(p.name, p.description, ...p.skills));
  const byLibrary = useMemo(() => {
    const groups = new Map<string, { name: string; skills: CatSkill[]; plugins: CatPlugin[] }>();
    for (const l of catalog?.libraries ?? []) groups.set(l.id, { name: l.name, skills: [], plugins: [] });
    for (const s of catalog?.skills ?? []) groups.get(s.library)?.skills.push(s);
    for (const p of catalog?.plugins ?? []) groups.get(p.library)?.plugins.push(p);
    return groups;
  }, [catalog]);

  const addItems: { label: string; hint: string; act: "upload" | "create" | "github" }[] =
    kind === "skills"
      ? [
          { label: "Upload skill", hint: "A SKILL.md, or a .zip of a skill folder", act: "upload" },
          { label: "Create a skill", hint: "Write its instructions here", act: "create" },
          { label: "Add from GitHub", hint: "A repository with skills", act: "github" },
        ]
      : [
          { label: "Upload plugin", hint: "A .zip of a plugin folder", act: "upload" },
          { label: "Add marketplace", hint: "A GitHub repository with plugins", act: "github" },
        ];
  const doAdd = (act: "upload" | "create" | "github") => {
    if (act === "upload") picker.current?.click();
    else setPage({ kind: act });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(false);
        }}
        className="flex h-[min(86vh,720px)] w-[760px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <input
          ref={picker}
          type="file"
          accept={kind === "skills" ? ".md,.zip,.skill" : ".zip"}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <div className="flex items-center gap-3 border-b border-[#F0F0EE] px-[22px] py-[16px]">
          <span className="text-[18px] font-semibold leading-[22px]">{title}</span>
          <div className="flex rounded-full bg-[#F2F2F0] p-[3px]">
            {(["yours", "discover"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  setPage(null);
                }}
                className={`rounded-full px-3 py-1 text-[12.5px] font-medium leading-4 ${tab === t && !page ? "bg-white text-ink shadow-[0_1px_2px_#0000001A]" : "text-[#6B6B6B] hover:text-ink"}`}
              >
                {t === "yours" ? "Yours" : "Discover"}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <label className="flex h-8 w-[200px] items-center gap-2 rounded-full bg-[#F7F7F6] px-3 shadow-[0_0_0_1px_#ECECEA] focus-within:shadow-[0_0_0_1.5px_#16132B]">
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[#9A9A98]">
              <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.4 10.4l3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${title.toLowerCase()}`} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9A9A98]" />
          </label>
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenu((m) => !m);
              }}
              disabled={busy === "upload"}
              className={`${darkButton} flex items-center gap-1.5`}
            >
              {busy === "upload" ? "Adding…" : "+ Add"}
              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 top-full z-10 mt-1.5 flex w-[240px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_16px_40px_-12px_#00000040]">
                {addItems.map((a) => (
                  <button
                    key={a.label}
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      doAdd(a.act);
                    }}
                    className="flex flex-col rounded-[10px] px-2.5 py-1.5 text-left hover:bg-[#F2F2F0]"
                  >
                    <span className="text-[13px] font-medium leading-[18px]">{a.label}</span>
                    <span className="text-[11.5px] leading-4 text-[#9A9A98]">{a.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3]">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#16132B" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {(error || note) && (
          <div role={error ? "alert" : "status"} className={`flex items-center gap-2 px-[22px] py-2 text-[12.5px] leading-[17px] ${error ? "bg-[#FEF3F2] text-[#B42318]" : "bg-[#F0F9F3] text-[#1E7A44]"}`}>
            <span className="flex-1">{error ?? note}</span>
            <button onClick={() => (setError(null), setNote(null))} aria-label="Dismiss" className="text-[16px] leading-none opacity-60 hover:opacity-100">
              ×
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-5 pt-3">
          {page?.kind === "create" ? (
            <CreateSkill
              onCancel={() => setPage(null)}
              onCreated={async (id) => {
                setPage(null);
                setTab("yours");
                setNote(`Created ${id}. Type /${id} in a chat to use it.`);
                await readMine();
              }}
            />
          ) : page?.kind === "github" ? (
            <AddGithub
              kind={kind}
              onCancel={() => setPage(null)}
              onAdded={(c) => {
                setCatalog(c);
                setPage(null);
                setTab("discover");
                setNote(kind === "skills" ? "Added. Its skills are listed below." : "Added. Its plugins are listed below.");
              }}
            />
          ) : page?.kind === "skill" ? (
            <SkillPage
              id={page.id}
              onBack={() => setPage(null)}
              onChanged={async (gone) => {
                if (gone) setPage(null);
                setCatalog(null);
                await readMine();
              }}
            />
          ) : page?.kind === "plugin" ? (
            <PluginPage
              plugin={(plugins ?? []).find((p) => p.name === page.name)}
              onBack={() => setPage(null)}
              onOpenSkill={(id) => setPage({ kind: "skill", id })}
              onRemoved={async () => {
                setPage(null);
                setCatalog(null);
                await readMine();
              }}
            />
          ) : tab === "yours" ? (
            kind === "skills" ? (
              skills === null ? (
                <Quiet>Loading…</Quiet>
              ) : !skills.length ? (
                <Empty
                  title="No skills yet"
                  line="A skill is a set of instructions your bots follow for one kind of job: your weekly report, how you write quotes, your brand. Find one in Discover, or upload or create your own."
                  action="Browse skills"
                  onAction={() => setTab("discover")}
                />
              ) : (
                <>
                  <Section title="Your skills" count={ownSkills.length}>
                    {ownSkills.map((s) => (
                      <Row
                        key={s.id}
                        icon="skill"
                        name={s.name}
                        chips={[]}
                        line={`${sourceWords(s.source)} · ${ago(s.addedAt)} · ${s.description}`}
                        onOpen={() => setPage({ kind: "skill", id: s.id })}
                        right={<Switch on={s.enabled} label={`${s.name} on`} disabled={busy === s.id} onChange={(on) => void toggleSkill(s, on)} />}
                      />
                    ))}
                    {!ownSkills.length && <Quiet>{q ? "None match." : "None yet."}</Quiet>}
                  </Section>
                  {pluginSkills.length > 0 && (
                    <Section title="From your plugins" count={pluginSkills.length}>
                      {pluginSkills.map((s) => (
                        <Row key={s.id} icon="skill" name={s.id} chips={s.enabled ? [] : ["Off"]} line={s.description} onOpen={() => setPage({ kind: "skill", id: s.id })} />
                      ))}
                    </Section>
                  )}
                </>
              )
            ) : plugins === null ? (
              <Quiet>Loading…</Quiet>
            ) : !plugins.length ? (
              <Empty
                title="No plugins yet"
                line="A plugin is a set of skills and commands for one line of work: sales, finance, marketing, support. Find one in Discover, or upload one."
                action="Browse plugins"
                onAction={() => setTab("discover")}
              />
            ) : (
              <Section title="Your plugins" count={minePlugins.length}>
                {minePlugins.map((p) => (
                  <Row
                    key={p.name}
                    icon="plugin"
                    name={p.name}
                    chips={[...(p.version ? [`v${p.version}`] : []), ...(p.marketplace ? [p.marketplace] : [])]}
                    line={`${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}${p.commands.length ? ` · ${p.commands.length} command${p.commands.length === 1 ? "" : "s"}` : ""} · ${p.description}`}
                    onOpen={() => setPage({ kind: "plugin", name: p.name })}
                    right={<Switch on={p.enabled} label={`${p.name} on`} disabled={busy === p.name} onChange={(on) => void togglePlugin(p, on)} />}
                  />
                ))}
                {!minePlugins.length && <Quiet>None match.</Quiet>}
              </Section>
            )
          ) : (
            <Discover
              kind={kind}
              catalog={catalog}
              loading={loadingCatalog}
              groups={byLibrary}
              match={match}
              busy={busy}
              onRefresh={() => void readCatalog(true)}
              onAddSkill={(c) => void addSkill(c)}
              onAddPlugin={(c) => void addPlugin(c)}
              onRemoveLibrary={async (id) => {
                const r = await send<Catalog>("/api/library", { action: "remove-library", id });
                if (r.error) return setError(r.error);
                setCatalog(r);
              }}
              onAddGithub={() => setPage({ kind: "github" })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-3 text-[12.5px] text-[#9A9A98]">{children}</div>;
}

function Empty({ title, line, action, onAction }: { title: string; line: string; action: string; onAction: () => void }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 py-14 text-center">
      <span className="text-[15px] font-semibold">{title}</span>
      <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{line}</span>
      <button onClick={onAction} className={`${darkButton} mt-2`}>
        {action}
      </button>
    </div>
  );
}

function Section({ title, count, right, children }: { title: string; count?: number; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col pt-3">
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="text-[13px] font-semibold">{title}</span>
        {count !== undefined && <span className="rounded-full bg-[#F2F2F0] px-1.5 text-[11px] font-medium leading-[17px] text-[#6B6B6B]">{count}</span>}
        <span className="flex-1" />
        {right}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({ icon, name, chips, line, onOpen, right }: { icon: "skill" | "plugin"; name: string; chips: string[]; line: string; onOpen?: () => void; right?: React.ReactNode }) {
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => onOpen && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className={`flex items-center gap-3 rounded-[12px] px-1.5 py-2 ${onOpen ? "cursor-pointer hover:bg-[#F7F7F6]" : ""}`}
    >
      <Icon kind={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold leading-[18px]">{name}</span>
          {chips.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
        </span>
        <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{line}</span>
      </div>
      {right}
    </div>
  );
}

function AddButton({ added, busy, label, onAdd }: { added: boolean; busy: boolean; label: string; onAdd: () => void }) {
  if (added)
    return (
      <span className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-[#1E7A44]" aria-label={`${label} added`}>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Added
      </span>
    );
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
      disabled={busy}
      aria-label={`Add ${label}`}
      data-tip={`Add ${label}`}
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6] disabled:opacity-50"
    >
      {busy ? (
        <span className="size-3 animate-spin rounded-full border-[1.5px] border-[#16132B]/20 border-t-[#16132B]" />
      ) : (
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M6 1.8v8.4M1.8 6h8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function Discover({
  kind,
  catalog,
  loading,
  groups,
  match,
  busy,
  onRefresh,
  onAddSkill,
  onAddPlugin,
  onRemoveLibrary,
  onAddGithub,
}: {
  kind: LibraryKind;
  catalog: Catalog | null;
  loading: boolean;
  groups: Map<string, { name: string; skills: CatSkill[]; plugins: CatPlugin[] }>;
  match: (...w: (string | undefined)[]) => boolean;
  busy: string | null;
  onRefresh: () => void;
  onAddSkill: (c: CatSkill) => void;
  onAddPlugin: (c: CatPlugin) => void;
  onRemoveLibrary: (id: string) => void;
  onAddGithub: () => void;
}) {
  if (!catalog)
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-[12.5px] text-[#6B6B6B]">
        <span className="size-5 animate-spin rounded-full border-2 border-[#16132B]/15 border-t-[#16132B]" />
        {loading ? "Reading the libraries from GitHub… the first time takes a few seconds." : "Loading…"}
      </div>
    );
  // Each library under the kind it has (one the user added, under both while it has nothing yet).
  const libs = catalog.libraries.filter((l) => (l.only ? l.only === kind : l.error || (kind === "skills" ? l.skills > 0 : l.plugins > 0) || (!l.skills && !l.plugins)));
  const searching = !match();
  const itemsOf = (id: string) => {
    const g = groups.get(id);
    return kind === "skills" ? (g?.skills ?? []).filter((s) => match(s.name, s.description, s.libraryName)) : (g?.plugins ?? []).filter((p) => match(p.name, p.description, p.category, p.libraryName));
  };
  const shown = libs.reduce((n, l) => n + itemsOf(l.id).length, 0);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-1 pt-1 text-[12px] leading-4 text-[#6B6B6B]">
        <span className="flex-1">
          {kind === "skills"
            ? "Free skills from Anthropic, OpenAI and GitHub. Added ones are copied to this PC, and your bots use them when a job fits."
            : "Plugins bundle skills and commands for a line of work. Their own app connections (MCP) aren't used: connect apps in the Vault."}
        </span>
        <button onClick={onRefresh} disabled={loading} className="shrink-0 font-medium text-ink underline-offset-2 hover:underline disabled:opacity-40">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {libs.map((l) => {
        const items = itemsOf(l.id);
        if (!items.length && !l.error && (searching || l.builtIn)) return null;
        return (
          <Section
            key={l.id}
            title={l.name}
            count={items.length}
            right={
              <span className="flex items-center gap-3 text-[11.5px]">
                <a href={`https://github.com/${l.repo}`} target="_blank" rel="noreferrer" className="text-[#9A9A98] hover:text-ink">
                  github.com/{l.repo}
                </a>
                {!l.builtIn && (
                  <button onClick={() => onRemoveLibrary(l.id)} className="text-[#9A9A98] hover:text-[#B42318]">
                    Remove
                  </button>
                )}
              </span>
            }
          >
            {l.error && <div className="px-1 py-2 text-[12px] text-[#B42318]">{`Couldn't read it: ${l.error}`}</div>}
            {kind === "skills"
              ? (items as CatSkill[]).map((s) => (
                  <Row
                    key={s.folder}
                    icon="skill"
                    name={s.name}
                    chips={s.license && /apache|mit/i.test(s.license) ? [s.license.split(/[.(]/)[0].trim()] : []}
                    line={s.description}
                    right={<AddButton added={s.added} busy={busy === `${s.library}|${s.folder}`} label={s.name} onAdd={() => onAddSkill(s)} />}
                  />
                ))
              : (items as CatPlugin[]).map((p) => (
                  <Row
                    key={p.folder}
                    icon="plugin"
                    name={p.name}
                    chips={p.category ? [p.category] : []}
                    line={`${p.skills} skill${p.skills === 1 ? "" : "s"}${p.commands ? ` · ${p.commands} command${p.commands === 1 ? "" : "s"}` : ""} · ${p.description}`}
                    right={<AddButton added={p.added} busy={busy === `${p.library}|${p.folder}`} label={p.name} onAdd={() => onAddPlugin(p)} />}
                  />
                ))}
          </Section>
        );
      })}
      {shown === 0 && <Quiet>Nothing matches. Try other words, or add a GitHub repository.</Quiet>}
      <button onClick={onAddGithub} className="mt-4 self-start px-1 text-[12.5px] font-medium text-ink underline-offset-2 hover:underline">
        {kind === "skills" ? "+ Add skills from a GitHub repository" : "+ Add a marketplace from GitHub"}
      </button>
    </div>
  );
}

function CreateSkill({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await send<{ id: string }>("/api/skills", { action: "create", name, description, body });
    setBusy(false);
    if (r.error) return setError(r.error);
    onCreated(r.id);
  };
  return (
    <div className="flex flex-col gap-3 pt-2">
      <span className="text-[15px] font-semibold">Create a skill</span>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Skill name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly status report" className={field} maxLength={64} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Description</span>
        <span className="text-[11.5px] leading-4 text-[#9A9A98]">What it does and when to use it: your bots read this to know when it fits.</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Write weekly status reports from recent work. Use when asked for updates or progress summaries." className={`${field} resize-none`} maxLength={1024} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Instructions</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff…"
          className={`${field} resize-y font-mono text-[12.5px]`}
        />
      </label>
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className={lightButton}>
          Cancel
        </button>
        <button onClick={() => void create()} disabled={busy || !name.trim() || !description.trim() || !body.trim()} className={darkButton}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

function AddGithub({ kind, onCancel, onAdded }: { kind: LibraryKind; onCancel: () => void; onAdded: (c: Catalog) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    const r = await send<Catalog>("/api/library", { action: "add-library", url });
    setBusy(false);
    if (r.error) return setError(r.error);
    onAdded(r);
  };
  return (
    <div className="flex flex-col gap-3 pt-2">
      <span className="text-[15px] font-semibold">{kind === "skills" ? "Add skills from GitHub" : "Add a marketplace"}</span>
      <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">
        {kind === "skills"
          ? "A public GitHub repository with skills (folders with a SKILL.md), or one folder in it. Its skills show in Discover, to add the ones you want."
          : "A public GitHub repository with a plugin marketplace (.claude-plugin/marketplace.json) or one plugin. Its plugins show in Discover."}
      </span>
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && url.trim() && !busy && void add()}
        placeholder="owner/repository, or https://github.com/owner/repository"
        className={field}
        spellCheck={false}
      />
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className={lightButton}>
          Cancel
        </button>
        <button onClick={() => void add()} disabled={busy || !url.trim()} className={darkButton}>
          {busy ? "Reading it…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function SkillPage({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: (gone: boolean) => void }) {
  const [skill, setSkill] = useState<SkillFull | null>(null);
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let live = true;
    void call<{ skill: SkillFull }>(`/api/skills?id=${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.error || !r.skill) return setError(r.error ?? "That skill isn't here anymore.");
      setSkill(r.skill);
      setDescription(r.skill.description);
      setBody(r.skill.body);
    });
    return () => {
      live = false;
    };
  }, [id]);
  if (!skill) return <Quiet>{error ?? "Loading…"}</Quiet>;
  const own = !skill.plugin;
  const changed = description.trim() !== skill.description || body.trim() !== skill.body.trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await send("/api/skills", { action: "save", id, description, body });
    setBusy(false);
    if (r.error) return setError(r.error);
    setSkill({ ...skill, description: description.trim(), body: body.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    onChanged(false);
  };
  const remove = async () => {
    setBusy(true);
    const r = await send("/api/skills", { action: "remove", id });
    setBusy(false);
    if (r.error) return setError(r.error);
    onChanged(true);
  };
  return (
    <div className="flex flex-col gap-3 pt-2">
      <button onClick={onBack} className="self-start text-[12.5px] font-medium text-[#6B6B6B] hover:text-ink">
        ← Back
      </button>
      <div className="flex items-center gap-3">
        <Icon kind="skill" size={36} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[16px] font-semibold leading-5">{skill.plugin ? skill.id : skill.name}</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">
            {sourceWords(skill.source, skill.plugin)} · added {ago(skill.addedAt)}
            {skill.license ? ` · ${skill.license}` : ""}
            {skill.source.kind === "library" && (
              <>
                {" · "}
                <a href={`https://github.com/${skill.source.repo}/tree/${skill.source.ref ?? "HEAD"}/${skill.source.path}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  on GitHub
                </a>
              </>
            )}
          </span>
        </div>
        <span className="text-[12px] text-[#6B6B6B]">Use it in a chat: /{skill.id}</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} readOnly={!own} rows={3} className={`${field} resize-none ${own ? "" : "bg-[#F7F7F6]"}`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Instructions</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} readOnly={!own} rows={16} className={`${field} resize-y font-mono text-[12px] leading-[17px] ${own ? "" : "bg-[#F7F7F6]"}`} />
      </label>
      {skill.files.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">Its other files ({skill.files.length})</span>
          <span className="text-[12px] leading-[17px] text-[#6B6B6B]">
            {skill.files.slice(0, 30).join(" · ")}
            {skill.files.length > 30 ? " …" : ""}
          </span>
        </div>
      )}
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        {own &&
          (confirm ? (
            <span className="flex items-center gap-3 text-[12.5px]">
              <span>Remove {skill.name}?</span>
              <button onClick={() => void remove()} disabled={busy} className="font-medium text-[#B42318]">
                Remove
              </button>
              <button onClick={() => setConfirm(false)} className="font-medium text-ink">
                Keep
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirm(true)} className="text-[12.5px] text-[#9A9A98] hover:text-[#B42318]">
              Remove skill
            </button>
          ))}
        {!own && <span className="text-[12px] text-[#9A9A98]">It comes with the {skill.plugin} plugin: turn it off or remove it in Plugins.</span>}
        <span className="flex-1" />
        {saved && <span className="text-[12px] text-[#1E7A44]">Saved</span>}
        {own && (
          <button onClick={() => void save()} disabled={busy || !changed || !description.trim() || !body.trim()} className={darkButton}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

function PluginPage({ plugin: p, onBack, onOpenSkill, onRemoved }: { plugin?: Plugin; onBack: () => void; onOpenSkill: (id: string) => void; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!p) return <Quiet>That plugin isn&apos;t here anymore.</Quiet>;
  const remove = async () => {
    const r = await send("/api/plugins", { action: "remove", name: p.name });
    if (r.error) return setError(r.error);
    onRemoved();
  };
  return (
    <div className="flex flex-col gap-3 pt-2">
      <button onClick={onBack} className="self-start text-[12.5px] font-medium text-[#6B6B6B] hover:text-ink">
        ← Back
      </button>
      <div className="flex items-center gap-3">
        <Icon kind="plugin" size={36} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[16px] font-semibold leading-5">
            {p.name}
            {p.version ? <span className="font-normal text-[#9A9A98]"> v{p.version}</span> : null}
          </span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">
            {[p.author ? `by ${p.author}` : "", p.marketplace ? `from ${p.marketplace}` : sourceWords(p.source), `added ${ago(p.addedAt)}`].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      {p.description && <p className="m-0 text-[13px] leading-[19px] text-[#3A3A38]">{p.description}</p>}
      {p.unused.length > 0 && (
        <p className="m-0 rounded-[12px] bg-[#F7F7F6] px-3 py-2 text-[12px] leading-[17px] text-[#6B6B6B]">
          It also has {p.unused.join(", ")}, which Deskwisp doesn&apos;t run. Its skills say which apps they work with: connect those in the Vault, and give your bots access.
        </p>
      )}
      <Section title="Skills" count={p.skills.length}>
        {p.skills.map((s) => (
          <Row key={s} icon="skill" name={`${p.name}:${s}`} chips={[]} line={`Type /${p.name}:${s} in a chat`} onOpen={() => onOpenSkill(`${p.name}:${s}`)} />
        ))}
      </Section>
      {p.commands.length > 0 && (
        <Section title="Commands" count={p.commands.length}>
          {p.commands.map((c) => (
            <div key={c} className="flex items-center gap-3 px-1.5 py-2">
              <Icon kind="command" />
              <span className="text-[13px] font-medium">/{p.name}:{c}</span>
            </div>
          ))}
        </Section>
      )}
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-3 pt-2 text-[12.5px]">
        {confirm ? (
          <>
            <span>Remove {p.name} and its skills?</span>
            <button onClick={() => void remove()} className="font-medium text-[#B42318]">
              Remove
            </button>
            <button onClick={() => setConfirm(false)} className="font-medium text-ink">
              Keep
            </button>
          </>
        ) : (
          <button onClick={() => setConfirm(true)} className="text-[#9A9A98] hover:text-[#B42318]">
            Remove plugin
          </button>
        )}
      </div>
    </div>
  );
}
