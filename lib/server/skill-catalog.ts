import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTarGz, type ArchiveFile } from "@/lib/archive";
import { openLicense, pluginParts, readMarketplace, readPluginJson, readSkill, skillFolders, slugOf, within } from "@/lib/skills-core";
import { installPluginFiles, installSkillFiles, listPlugins, listSkills } from "./skill-library";
import { userDir } from "./store";

/**
 * Discover, in Skills and Plugins: libraries of skills and plugins on GitHub, to add with "+".
 *
 * - The built-in libraries (LIBRARIES) are Anthropic's skills and plugins for work, OpenAI's skills, and
 *   Claude's official plugins; the user can add any public GitHub repository (or a folder in one) that
 *   has skills (folders with a SKILL.md) or plugins (a .claude-plugin/marketplace.json, or one plugin).
 * - Each library comes down as one archive of the repository from GitHub (github.com/<repo>/archive),
 *   kept in the user's folder (library/<owner>__<repo>.tar.gz, with what's in it in a .json next to it)
 *   for a day, then read again when Discover opens (or at once with Refresh). No GitHub API: its limit
 *   (60 an hour) would run out. What's added is copied from that archive, as it was.
 * - Only skills that say they're free to use and share are listed (an Apache, MIT or similar license
 *   in their folder, front matter or repository): Anthropic's PDF, Word, PowerPoint and Excel skills
 *   are proprietary and aren't. A plugin is listed when its files are in the library (a marketplace's
 *   plugins in other repositories aren't read) and it has skills or commands Deskwisp can use.
 */

export type Library = {
  id: string;
  repo: string;
  ref?: string;
  folder?: string;
  name: string;
  builtIn?: boolean;
  /** A built-in library read for one kind only (a plugin marketplace's loose example skills aren't listed). */
  only?: "skills" | "plugins";
};

export const LIBRARIES: Library[] = [
  { id: "anthropics/skills", repo: "anthropics/skills", folder: "skills", name: "Anthropic skills", builtIn: true, only: "skills" },
  { id: "anthropics/knowledge-work-plugins", repo: "anthropics/knowledge-work-plugins", name: "Anthropic plugins for work", builtIn: true, only: "plugins" },
  // Its .curated skills: the .system ones are Codex's own.
  { id: "openai/skills", repo: "openai/skills", folder: "skills/.curated", name: "OpenAI skills", builtIn: true, only: "skills" },
  { id: "anthropics/claude-plugins-official", repo: "anthropics/claude-plugins-official", name: "Claude plugins", builtIn: true, only: "plugins" },
];

export type CatalogSkill = { library: string; libraryName: string; folder: string; name: string; description: string; license?: string; plugin?: string };
export type CatalogPlugin = {
  library: string;
  libraryName: string;
  folder: string;
  name: string;
  description: string;
  category?: string;
  author?: string;
  skills: number;
  commands: number;
  unused: string[];
};
type Index = { fetchedAt: number; sha?: string; skills: CatalogSkill[]; plugins: CatalogPlugin[] };
export type LibraryState = Library & { fetchedAt?: number; error?: string; skills: number; plugins: number };

const DAY = 24 * 60 * 60_000;
const ARCHIVE_LIMITS = { maxFiles: 20_000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 150 * 1024 * 1024 };
const MAX_DOWNLOAD = 60 * 1024 * 1024;

function dir() {
  const d = userDir();
  if (d === null) throw new Error("Sign in to Deskwisp first.");
  const lib = join(d, "library");
  mkdirSync(lib, { recursive: true });
  return lib;
}
const fileOf = (l: Library, ext: string) => join(dir(), `${l.id.replace(/[^\w.-]+/g, "__")}${ext}`);

/** The libraries the user added (library/sources.json). */
function added(): Library[] {
  try {
    const j = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(dir(), "sources.json"), "utf8")) as Library[];
    return Array.isArray(j) ? j.filter((l) => l && typeof l.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(l.repo)) : [];
  } catch {
    return [];
  }
}
export const libraries = () => [...LIBRARIES, ...added()];

/**
 * "owner/repo", "https://github.com/owner/repo", or a folder in one
 * ("https://github.com/owner/repo/tree/main/skills/x") as a library, or why not.
 */
export function parseLibrary(input: string): Library | { error: string } {
  const t = input.trim().replace(/\/+$/, "");
  let m = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/.exec(t);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)$/.exec(t) as RegExpExecArray | null;
  if (!m) return { error: "Paste a GitHub repository: owner/name, or its github.com link." };
  const repo = `${m[1]}/${m[2]}`;
  const folder = m[4] ? decodeURIComponent(m[4]).split("/").filter((p) => p && p !== "." && p !== "..").join("/") : undefined;
  return { id: folder ? `${repo}/${folder}` : repo, repo, ...(m[3] ? { ref: decodeURIComponent(m[3]) } : {}), ...(folder ? { folder } : {}), name: folder ? `${repo}/${folder}` : repo };
}

/** The repository's files, as GitHub's archive of it (its top folder taken off), and the commit it's at. */
async function download(l: Library, fetchImpl: typeof fetch): Promise<{ files: ArchiveFile[]; sha?: string; raw: Buffer }> {
  const url = `https://github.com/${l.repo}/archive/${encodeURIComponent(l.ref ?? "HEAD")}.tar.gz`;
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) throw new Error("GitHub has no public repository there.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_DOWNLOAD) throw new Error("That repository is too big to read here.");
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > MAX_DOWNLOAD) throw new Error("That repository is too big to read here.");
  return { raw, ...unpack(raw) };
}

function unpack(raw: Buffer) {
  let all: ArchiveFile[];
  try {
    all = readTarGz(raw, ARCHIVE_LIMITS);
  } catch (e) {
    throw new Error((e as Error).message.startsWith("That archive") ? "That repository is too big to read here." : "GitHub's archive of it couldn't be read.");
  }
  const top = all[0]?.path.split("/")[0] ?? "";
  // GitHub names the top folder "<repo>-<commit>" for a commit-less ref like HEAD.
  const sha = /-([0-9a-f]{40})$/.exec(top)?.[1];
  return { sha, files: all.filter((f) => f.path.startsWith(`${top}/`)).map((f) => ({ path: f.path.slice(top.length + 1), data: f.data })) };
}

const text = (files: Map<string, Buffer>, p: string) => files.get(p)?.toString("utf8");

/** What's in a library: its skills that are free to use, and its plugins Deskwisp can use. */
export function scan(l: Library, all: ArchiveFile[]): Omit<Index, "fetchedAt" | "sha"> {
  const base = l.folder ?? "";
  const scoped = base ? all.filter((f) => f.path === base || f.path.startsWith(`${base}/`)) : all;
  const files = new Map(all.map((f) => [f.path, f.data]));
  const paths = scoped.map((f) => f.path);
  const rootLicense = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE-APACHE"].map((p) => text(files, p)).find(Boolean) ?? "";
  const skills: CatalogSkill[] = [];
  const plugins: CatalogPlugin[] = [];

  // Plugins: a marketplace (its plugins in this repository), or the folder is one plugin.
  const market = text(files, `${base ? `${base}/` : ""}.claude-plugin/marketplace.json`);
  const entries = market ? (readMarketplace(market)?.plugins ?? []) : [];
  const pluginFolders = new Set<string>();
  const addPlugin = (folder: string, name: string, description: string, extra: { category?: string; author?: string } = {}) => {
    const inside = within(paths, folder);
    const parts = pluginParts(inside);
    if (!parts.skills.length && !parts.commands.length) return;
    pluginFolders.add(folder);
    const info = readPluginJson(text(files, `${folder ? `${folder}/` : ""}.claude-plugin/plugin.json`) ?? "{}", folder);
    plugins.push({
      library: l.id,
      libraryName: l.name,
      folder,
      name: slugOf(name) || info?.name || "plugin",
      description: description || info?.description || "",
      ...(extra.category ? { category: extra.category } : {}),
      ...(extra.author ?? info?.author ? { author: extra.author ?? info?.author } : {}),
      skills: parts.skills.length,
      commands: parts.commands.length,
      unused: [...(parts.mcp ? ["MCP"] : []), ...(parts.hooks ? ["hooks"] : []), ...(parts.agents ? ["subagents"] : [])],
    });
  };
  for (const p of entries) if ("folder" in p.source && !("repo" in p.source)) addPlugin([base, p.source.folder].filter(Boolean).join("/"), p.name, p.description, p);
  if (!entries.length) {
    const own = text(files, `${base ? `${base}/` : ""}.claude-plugin/plugin.json`);
    const info = own ? readPluginJson(own, base || l.repo.split("/")[1]) : null;
    if (info) addPlugin(base, info.name, info.description, info);
  }

  // Skills: every folder with a SKILL.md (a marketplace's plugins' skills come with their plugin).
  for (const folder of skillFolders(paths)) {
    if (plugins.length && [...pluginFolders].some((p) => folder === p || folder.startsWith(`${p}/`))) continue;
    const md = text(files, folder ? `${folder}/SKILL.md` : "SKILL.md");
    const s = md && readSkill(md, folder.split("/").pop() || l.repo.split("/")[1]);
    if (!s) continue;
    const own = text(files, `${folder}/LICENSE.txt`) ?? text(files, `${folder}/LICENSE`) ?? text(files, `${folder}/LICENSE.md`);
    const free =
      own !== undefined ? openLicense(own) : s.license && /proprietar/i.test(s.license) ? false : s.license && openLicense(s.license) ? true : openLicense(rootLicense);
    if (!free) continue;
    skills.push({ library: l.id, libraryName: l.name, folder, name: s.name, description: s.description.slice(0, 600), ...(s.license ? { license: s.license.slice(0, 80) } : {}) });
  }
  return { skills: l.only === "plugins" ? [] : skills, plugins: l.only === "skills" ? [] : plugins };
}

/** One library's index: kept for a day, read again from GitHub after that (or with `refresh`). */
async function indexOf(l: Library, { refresh = false, fetchImpl = fetch }: { refresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<Index> {
  const idx = fileOf(l, ".json");
  const tgz = fileOf(l, ".tar.gz");
  if (!refresh && existsSync(idx) && existsSync(tgz)) {
    try {
      const kept = JSON.parse(readFileSync(/*turbopackIgnore: true*/ idx, "utf8")) as Index;
      if (Date.now() - kept.fetchedAt < DAY) return kept;
    } catch {}
  }
  const { raw, files, sha } = await download(l, fetchImpl);
  const index: Index = { fetchedAt: Date.now(), ...(sha ? { sha } : {}), ...scan(l, files) };
  writeFileSync(/*turbopackIgnore: true*/ `${tgz}.part`, raw);
  renameSync(`${tgz}.part`, tgz);
  writeFileSync(/*turbopackIgnore: true*/ idx, JSON.stringify(index));
  return index;
}

/** A library's files, from the archive kept for it (downloaded again if it isn't there). */
async function filesOf(l: Library, fetchImpl: typeof fetch = fetch) {
  const tgz = fileOf(l, ".tar.gz");
  if (!existsSync(tgz)) await indexOf(l, { refresh: true, fetchImpl });
  const index = JSON.parse(readFileSync(/*turbopackIgnore: true*/ fileOf(l, ".json"), "utf8")) as Index;
  return { index, files: unpack(readFileSync(/*turbopackIgnore: true*/ tgz)).files };
}

/** Everything in every library, for Discover: each library's state (with why one couldn't be read), its skills and plugins, and which are added already. */
export async function catalog({ refresh = false, fetchImpl = fetch }: { refresh?: boolean; fetchImpl?: typeof fetch } = {}) {
  const libs = libraries();
  const read = await Promise.all(libs.map((l) => indexOf(l, { refresh, fetchImpl }).then((index) => ({ l, index }), (e: Error) => ({ l, error: e.message }))));
  const mineSkills = listSkills();
  const minePlugins = new Set(listPlugins().map((p) => p.name));
  const states: LibraryState[] = read.map((r) => ({ ...r.l, ...("index" in r ? { fetchedAt: r.index.fetchedAt, skills: r.index.skills.length, plugins: r.index.plugins.length } : { error: r.error, skills: 0, plugins: 0 }) }));
  const skills = read.flatMap((r) => ("index" in r ? r.index.skills : []));
  const plugins = read.flatMap((r) => ("index" in r ? r.index.plugins : []));
  const hasSkill = (s: CatalogSkill) =>
    mineSkills.some((m) => !m.plugin && m.source.kind === "library" && m.source.repo === libs.find((l) => l.id === s.library)?.repo && m.source.path === s.folder);
  return {
    libraries: states,
    skills: skills.map((s) => ({ ...s, added: hasSkill(s) })),
    plugins: plugins.map((p) => ({ ...p, added: minePlugins.has(p.name) })),
  };
}

const libraryById = (id: string) => {
  const l = libraries().find((x) => x.id === id);
  if (!l) throw new Error("That library isn't listed anymore.");
  return l;
};

/** "+" on a skill in Discover: copied from its library into the user's skills. */
export async function addFromLibrary(libraryId: string, folder: string, fetchImpl: typeof fetch = fetch) {
  const l = libraryById(libraryId);
  const { index, files } = await filesOf(l, fetchImpl);
  if (!index.skills.some((s) => s.folder === folder)) throw new Error("That skill isn't in the library anymore.");
  const pre = folder ? `${folder}/` : "";
  const mine = files.filter((f) => (pre ? f.path.startsWith(pre) : true)).map((f) => ({ path: f.path.slice(pre.length), data: f.data }));
  return installSkillFiles(folder.split("/").pop() || l.repo.split("/")[1], mine, { kind: "library", repo: l.repo, path: folder, library: l.id, ...(index.sha ? { ref: index.sha } : {}) });
}

/** "+" on a plugin in Discover: copied from its library into the user's plugins. */
export async function addPluginFromLibrary(libraryId: string, folder: string, fetchImpl: typeof fetch = fetch) {
  const l = libraryById(libraryId);
  const { index, files } = await filesOf(l, fetchImpl);
  const p = index.plugins.find((x) => x.folder === folder);
  if (!p) throw new Error("That plugin isn't in the library anymore.");
  const pre = folder ? `${folder}/` : "";
  const mine = files.filter((f) => (pre ? f.path.startsWith(pre) : true)).map((f) => ({ path: f.path.slice(pre.length), data: f.data }));
  return installPluginFiles(p.name, mine, { kind: "library", repo: l.repo, path: folder, library: l.id, ...(index.sha ? { ref: index.sha } : {}) }, { marketplace: l.name });
}

/** Add a GitHub repository (or a folder in one) as a library: read at once, so a wrong one says so now. */
export async function addLibrary(input: string, fetchImpl: typeof fetch = fetch) {
  const parsed = parseLibrary(input);
  if ("error" in parsed) throw new Error(parsed.error);
  if (libraries().some((l) => l.id === parsed.id)) return parsed;
  const index = await indexOf(parsed, { refresh: true, fetchImpl });
  if (!index.skills.length && !index.plugins.length) {
    rmSync(fileOf(parsed, ".json"), { force: true });
    rmSync(fileOf(parsed, ".tar.gz"), { force: true });
    throw new Error("There are no skills or plugins Deskwisp can use there (skills need a SKILL.md and a license that lets you use them).");
  }
  writeFileSync(/*turbopackIgnore: true*/ join(dir(), "sources.json"), JSON.stringify([...added(), parsed], null, 2));
  return parsed;
}

/** Take a library the user added off the list (what was added from it stays). */
export function removeLibrary(id: string) {
  if (LIBRARIES.some((l) => l.id === id)) throw new Error("The built-in libraries stay.");
  const l = added().find((x) => x.id === id);
  if (!l) return;
  writeFileSync(/*turbopackIgnore: true*/ join(dir(), "sources.json"), JSON.stringify(added().filter((x) => x.id !== id), null, 2));
  rmSync(fileOf(l, ".json"), { force: true });
  rmSync(fileOf(l, ".tar.gz"), { force: true });
}
