import "server-only";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readArchive, type ArchiveFile } from "@/lib/archive";
import { editSkillMd, fillCommand, frontMatter, invocations, isSlug, pluginParts, readCommand, readPluginJson, readSkill, skillFolders, skillMd, slugOf, within } from "@/lib/skills-core";
import { userDir } from "./store";

/**
 * The user's skills and plugins on this PC (Skills and Plugins, from the You menu or "/" in a chat):
 *
 *   <user folder>/skills/<name>/          a skill: SKILL.md and its files, and .deskwisp.json (where it came
 *                                         from, whether it's on, when it was added)
 *   <user folder>/plugins/<name>/         a plugin as it came (.claude-plugin/plugin.json, skills/, commands/…)
 *                                         and its .deskwisp.json
 *
 * Skills come from Create a skill (what the user typed), Upload (a SKILL.md, or a .zip of a skill, of
 * several, or of a plugin), or Discover (lib/server/skill-catalog.ts copies them from a GitHub library).
 * A plugin's skills are listed as "plugin:skill" and go with it; its commands are "/plugin:command".
 * What's on is what the bots use: listed in their instructions (chat.ts, sessions.ts), copied into a
 * task's skills folder on this PC (copySkillsTo), and the whole SKILL.md (or the command's prompt)
 * given to the bot when the user names one with "/" in a message (invokedNote).
 */

export type SkillSource =
  | { kind: "created" }
  | { kind: "uploaded"; file: string }
  | { kind: "library"; repo: string; path: string; ref?: string; library?: string };
type Meta = { source: SkillSource; enabled: boolean; addedAt: number };
export type PluginMeta = Meta & { marketplace?: string };

export type SkillItem = {
  /** "weekly-report", or "sales:call-prep" for a plugin's. */
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  plugin?: string;
  source: SkillSource;
  addedAt: number;
  license?: string;
};
export type CommandItem = { id: string; name: string; description: string; hint?: string; plugin: string };
export type PluginItem = {
  name: string;
  description: string;
  version?: string;
  author?: string;
  enabled: boolean;
  source: SkillSource;
  marketplace?: string;
  addedAt: number;
  skills: string[];
  commands: string[];
  /** Parts Deskwisp doesn't run: its own MCP servers, hooks, subagents. */
  unused: string[];
};

const META = ".deskwisp.json";
/** One skill's files at most, and a plugin's. */
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 800;
/** An uploaded file at most. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function roots() {
  const dir = userDir();
  if (dir === null) throw new Error("Sign in to Deskwisp first.");
  return { skills: join(dir, "skills"), plugins: join(dir, "plugins") };
}

const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as T;
  } catch {
    return null;
  }
};
const dirs = (root: string) => {
  try {
    return readdirSync(/*turbopackIgnore: true*/ root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
};
/** Every file under a folder, as relative paths with forward slashes (META left out). */
function filesUnder(root: string, at = ""): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(/*turbopackIgnore: true*/ join(root, at), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(root, rel));
    else if (e.isFile() && rel !== META) out.push(rel);
  }
  return out;
}

/** Files written under `dir` (made fresh: a folder that was there goes first), never outside it. */
function writeFolder(dir: string, files: ArchiveFile[]) {
  if (files.length > MAX_FILES) throw new Error(`That has too many files (${files.length}; ${MAX_FILES} at most).`);
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  if (bytes > MAX_SKILL_BYTES) throw new Error(`That's too big (${Math.round(bytes / 1024 / 1024)} MB; 25 MB at most).`);
  const tmp = `${dir}.new-${process.pid}-${Date.now().toString(36)}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const base = resolve(tmp);
  try {
    for (const f of files) {
      const to = resolve(base, f.path);
      if (!to.startsWith(base + sep) || f.path === META) continue;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(/*turbopackIgnore: true*/ to, f.data);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** A skill's folder name that isn't taken (or is this one again, `replace`). */
function freeSlug(root: string, wanted: string, replace = false) {
  const base = isSlug(wanted) ? wanted : slugOf(wanted) || "skill";
  if (replace || !existsSync(join(root, base))) return base;
  for (let n = 2; n < 100; n++) {
    const s = `${base.slice(0, 60)}-${n}`;
    if (!existsSync(join(root, s))) return s;
  }
  throw new Error("There are too many skills with that name.");
}

function skillAt(dir: string, folder: string, id: string, meta: Meta, plugin?: string): SkillItem | null {
  let text = "";
  try {
    text = readFileSync(/*turbopackIgnore: true*/ join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const s = readSkill(text, folder);
  if (!s) return null;
  return { id, name: s.name, description: s.description, enabled: meta.enabled, source: meta.source, addedAt: meta.addedAt, ...(plugin ? { plugin } : {}), ...(s.license ? { license: s.license } : {}) };
}

const fallbackMeta = (dir: string): Meta => {
  let at = Date.now();
  try {
    at = statSync(/*turbopackIgnore: true*/ dir).mtimeMs;
  } catch {}
  return { source: { kind: "uploaded", file: "" }, enabled: true, addedAt: at };
};

/** A plugin's skill folders (relative to the plugin), by their name. */
function pluginSkillDirs(pluginDir: string) {
  const out = new Map<string, string>();
  for (const f of pluginParts(filesUnder(pluginDir)).skills) {
    const name = slugOf(f.split("/").pop() || "") || "skill";
    if (!out.has(name)) out.set(name, f);
  }
  return out;
}

/** Every skill: the user's own, then the plugins' (a plugin that's off keeps its skills off). */
export function listSkills(): SkillItem[] {
  const { skills, plugins } = roots();
  const out: SkillItem[] = [];
  for (const slug of dirs(skills)) {
    const dir = join(skills, slug);
    const item = skillAt(dir, slug, slug, readJson<Meta>(join(dir, META)) ?? fallbackMeta(dir));
    if (item) out.push(item);
  }
  for (const p of dirs(plugins)) {
    const pdir = join(plugins, p);
    const meta = readJson<PluginMeta>(join(pdir, META)) ?? fallbackMeta(pdir);
    for (const [name, rel] of pluginSkillDirs(pdir)) {
      const item = skillAt(join(pdir, rel), name, `${p}:${name}`, meta, p);
      if (item) out.push(item);
    }
  }
  return out.sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id));
}

/** Where a skill's folder is, by its id. */
function skillDir(id: string) {
  const { skills, plugins } = roots();
  const [a, b] = id.split(":");
  if (b === undefined) return isSlug(a) && existsSync(join(skills, a, "SKILL.md")) ? join(skills, a) : null;
  if (!isSlug(a)) return null;
  const rel = pluginSkillDirs(join(plugins, a)).get(b);
  return rel ? join(plugins, a, rel) : null;
}

/** One skill in full: its SKILL.md and the names of its other files. */
export function getSkill(id: string) {
  const dir = skillDir(id);
  const item = listSkills().find((s) => s.id === id);
  if (!dir || !item) return null;
  const text = readFileSync(/*turbopackIgnore: true*/ join(dir, "SKILL.md"), "utf8");
  return { ...item, text, body: frontMatter(text).body.trim(), files: filesUnder(dir).filter((f) => f !== "SKILL.md").sort() };
}

const writeMeta = (dir: string, meta: Meta | PluginMeta) => writeFileSync(/*turbopackIgnore: true*/ join(dir, META), JSON.stringify(meta, null, 2));

/** Create a skill: a SKILL.md from its name, what it's for (when to use it) and its instructions. */
export function createSkill(name: string, description: string, body: string) {
  const slug = slugOf(name);
  if (!slug) throw new Error("Give the skill a name.");
  if (!description.trim()) throw new Error("Say what the skill is for and when to use it.");
  if (!body.trim()) throw new Error("Write the skill's instructions.");
  const { skills } = roots();
  if (existsSync(join(skills, slug))) throw new Error(`There's a skill called ${slug} already.`);
  const dir = join(skills, slug);
  writeFolder(dir, [{ path: "SKILL.md", data: Buffer.from(skillMd(slug, description.slice(0, 1024), body)) }]);
  writeMeta(dir, { source: { kind: "created" }, enabled: true, addedAt: Date.now() });
  return slug;
}

/** Change one of the user's own skills: what it's for and its instructions. A plugin's skills come and go with it. */
export function saveSkill(id: string, description: string, body: string) {
  if (id.includes(":")) throw new Error("A plugin's skills can't be changed here.");
  const dir = skillDir(id);
  if (!dir) throw new Error("That skill isn't here anymore.");
  if (!description.trim() || !body.trim()) throw new Error("A skill needs what it's for and its instructions.");
  const file = join(dir, "SKILL.md");
  writeFileSync(/*turbopackIgnore: true*/ file, editSkillMd(readFileSync(/*turbopackIgnore: true*/ file, "utf8"), description.slice(0, 1024), body));
}

/** A skill's files (relative to its folder, SKILL.md among them) put in as one of the user's skills. */
export function installSkillFiles(name: string, files: ArchiveFile[], source: SkillSource, replace = false) {
  const md = files.find((f) => f.path === "SKILL.md");
  const s = md && readSkill(md.data.toString("utf8"), name);
  if (!s) throw new Error("That skill has no SKILL.md with a description.");
  const { skills } = roots();
  const slug = freeSlug(skills, slugOf(s.name) || slugOf(name), replace);
  const dir = join(/*turbopackIgnore: true*/ skills, slug);
  writeFolder(dir, files);
  writeMeta(dir, { source, enabled: true, addedAt: Date.now() });
  return slug;
}

/** A plugin's files (relative to its folder) put in, replacing the one by that name. */
export function installPluginFiles(name: string, files: ArchiveFile[], source: SkillSource, extra: { marketplace?: string } = {}) {
  const slug = slugOf(name);
  if (!slug) throw new Error("That plugin has no name.");
  const parts = pluginParts(files.map((f) => f.path));
  if (!parts.skills.length && !parts.commands.length) throw new Error("That plugin has no skills or commands Deskwisp can use.");
  const dir = join(roots().plugins, slug);
  writeFolder(dir, files);
  writeMeta(dir, { source, enabled: true, addedAt: Date.now(), ...(extra.marketplace ? { marketplace: extra.marketplace } : {}) });
  return slug;
}

/**
 * Upload: a SKILL.md (or any .md with front matter), or an archive with a plugin (it has
 * .claude-plugin/plugin.json), one skill or several. Says what went in.
 */
export function uploadFile(filename: string, buf: Buffer): { skills: string[]; plugin?: string } {
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error("That file is too big (30 MB at most).");
  const lower = filename.toLowerCase();
  const source: SkillSource = { kind: "uploaded", file: filename.slice(0, 200) };
  if (lower.endsWith(".md")) {
    const text = buf.toString("utf8");
    const base = slugOf(filename.replace(/\.md$/i, "")) || "skill";
    const s = readSkill(text, base);
    if (!s) throw new Error("That file has no front matter with a description (--- name: … description: … ---).");
    return { skills: [installSkillFiles(lower === "skill.md" ? s.name : base, [{ path: "SKILL.md", data: buf }], source)] };
  }
  const files = readArchive(buf);
  const paths = files.map((f) => f.path);
  // A plugin, at the top or in one folder (a zip of the plugin's folder).
  const pj = paths.find((p) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p) && p.split("/").length <= 3);
  if (pj) {
    const folder = pj.replace(/\/?\.claude-plugin\/plugin\.json$/, "");
    const inside = files.filter((f) => !folder || f.path.startsWith(`${folder}/`)).map((f) => ({ path: folder ? f.path.slice(folder.length + 1) : f.path, data: f.data }));
    const info = readPluginJson(files.find((f) => f.path === pj)!.data.toString("utf8"), folder || filename.replace(/\.[^.]+$/, ""));
    if (!info?.name) throw new Error("That plugin's plugin.json has no name.");
    return { skills: [], plugin: installPluginFiles(info.name, inside, source) };
  }
  const folders = skillFolders(paths);
  if (!folders.length) throw new Error("There's no skill in that file: a skill is a folder with a SKILL.md in it.");
  const names: string[] = [];
  for (const folder of folders.slice(0, 50)) {
    const inside = within(paths, folder);
    const mine = new Set(inside);
    // Not a skill nested inside this one (a skill that ships examples of others).
    const nested = folders.filter((f) => f !== folder && (folder === "" || f.startsWith(`${folder}/`)));
    const own = files
      .filter((f) => (folder ? f.path.startsWith(`${folder}/`) : true) && mine.has(folder ? f.path.slice(folder.length + 1) : f.path))
      .filter((f) => !nested.some((n) => f.path.startsWith(`${n}/`)))
      .map((f) => ({ path: folder ? f.path.slice(folder.length + 1) : f.path, data: f.data }));
    names.push(installSkillFiles(folder.split("/").pop() || filename.replace(/\.[^.]+$/, ""), own, source));
  }
  return { skills: names };
}

/** Turn a skill on or off (a plugin's skills go with the plugin). */
export function setSkillEnabled(id: string, enabled: boolean) {
  if (id.includes(":")) return setPluginEnabled(id.split(":")[0], enabled);
  const dir = skillDir(id);
  if (!dir) throw new Error("That skill isn't here anymore.");
  const meta = readJson<Meta>(join(dir, META)) ?? fallbackMeta(dir);
  writeMeta(dir, { ...meta, enabled });
}

/** Remove one of the user's skills (a plugin's go when the plugin does). */
export function removeSkill(id: string) {
  if (id.includes(":")) throw new Error("This skill comes with its plugin: remove the plugin in Plugins.");
  const dir = skillDir(id);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function listPlugins(): PluginItem[] {
  const { plugins } = roots();
  const out: PluginItem[] = [];
  for (const p of dirs(plugins)) {
    const dir = join(plugins, p);
    const meta: PluginMeta = readJson<PluginMeta>(join(dir, META)) ?? fallbackMeta(dir);
    const files = filesUnder(dir);
    const info = (existsSync(join(dir, ".claude-plugin/plugin.json")) && readPluginJson(readFileSync(/*turbopackIgnore: true*/ join(dir, ".claude-plugin/plugin.json"), "utf8"), p)) || { name: p, description: "" };
    const parts = pluginParts(files);
    out.push({
      name: p,
      description: info.description,
      ...("version" in info && info.version ? { version: info.version } : {}),
      ...("author" in info && info.author ? { author: info.author } : {}),
      enabled: meta.enabled,
      source: meta.source,
      ...(meta.marketplace ? { marketplace: meta.marketplace } : {}),
      addedAt: meta.addedAt,
      skills: [...pluginSkillDirs(dir).keys()],
      commands: parts.commands.map((c) => slugOf(c.replace(/^commands\//, "").replace(/\.md$/i, ""))),
      unused: [...(parts.mcp ? ["its own app connections (MCP)"] : []), ...(parts.hooks ? ["hooks"] : []), ...(parts.agents ? ["subagents"] : [])],
    });
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

export function setPluginEnabled(name: string, enabled: boolean) {
  if (!isSlug(name)) throw new Error("No such plugin.");
  const dir = join(roots().plugins, name);
  if (!existsSync(dir)) throw new Error("That plugin isn't here anymore.");
  writeMeta(dir, { ...((readJson<PluginMeta>(join(dir, META)) ?? fallbackMeta(dir)) as PluginMeta), enabled });
}

export function removePlugin(name: string) {
  if (!isSlug(name)) return;
  rmSync(join(roots().plugins, name), { recursive: true, force: true });
}

/** The commands of the plugins that are on: "/plugin:command". */
export function listCommands(): CommandItem[] {
  const out: CommandItem[] = [];
  for (const p of listPlugins().filter((x) => x.enabled)) {
    const dir = join(roots().plugins, p.name, "commands");
    let names: string[] = [];
    try {
      names = readdirSync(/*turbopackIgnore: true*/ dir).filter((x) => x.toLowerCase().endsWith(".md"));
    } catch {}
    for (const f of names) {
      const c = readCommand(readFileSync(/*turbopackIgnore: true*/ join(dir, f), "utf8"), f);
      if (c) out.push({ id: `${p.name}:${c.name}`, name: c.name, description: c.description, ...(c.hint ? { hint: c.hint } : {}), plugin: p.name });
    }
  }
  return out;
}

/** What "/" in a chat lists: the skills and commands that are on. */
export function slashMenu() {
  return {
    skills: listSkills()
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, name: s.name, description: s.description, plugin: s.plugin })),
    commands: listCommands(),
  };
}

/** The skills that are on, for the bots' instructions. Never throws (signed out: none). */
export function enabledSkills(): SkillItem[] {
  try {
    return listSkills().filter((s) => s.enabled);
  } catch {
    return [];
  }
}

/** For a bot's instructions: its skills, by name and what they're for. Empty when there are none. */
export function skillsNote(mode: "chat" | "task") {
  const on = enabledSkills();
  if (!on.length) return "";
  // Each by what it's for (cut short), the first 60; past that only their names: a few big plugins
  // would otherwise make every prompt long.
  const words = (d: string) => {
    const t = d.replace(/\s+/g, " ").trim();
    return t.length > 180 ? `${t.slice(0, 179)}…` : t;
  };
  const list = [...on.slice(0, 60).map((s) => `- ${s.id}: ${words(s.description)}`), ...(on.length > 60 ? [`- and ${on.slice(60).map((s) => s.id).join(", ")}`] : [])].join("\n");
  return mode === "chat"
    ? `Your skills (instructions the user added for certain jobs). When a job fits one, follow it: read it with read_skill first, and when you start a task for it, say in the task which skill to use. The user can name one with "/" (like /${on[0].id}).\n${list}`
    : `Your skills (instructions the user added for certain jobs). When the task fits one, follow it: its SKILL.md and files are in your skills folder when the task runs on the PC, and its instructions are given with the task when it was asked for.\n${list}`;
}

/** A skill's full instructions for a bot, by id (read_skill). */
export function skillText(id: string) {
  const s = (() => {
    try {
      return getSkill(id.replace(/^\//, ""));
    } catch {
      return null;
    }
  })();
  if (!s || !s.enabled) return null;
  const files = s.files.length ? `\n\n(Its other files: ${s.files.slice(0, 40).join(", ")}${s.files.length > 40 ? "…" : ""}. They're in the task's skills folder on the PC.)` : "";
  return `Skill ${s.id}: ${s.description}\n\n${s.body.slice(0, 24_000)}${files}`;
}

/**
 * What the user asked for with "/" in a message: each skill's instructions, each command's prompt with
 * what they typed after it. Empty when they named none (or none that's on).
 */
export function invokedNote(text: string) {
  const calls = invocations(text);
  if (!calls.length) return { ids: [] as string[], note: "" };
  const commands = (() => {
    try {
      return listCommands();
    } catch {
      return [];
    }
  })();
  const parts: string[] = [];
  const ids: string[] = [];
  for (const c of calls.slice(0, 4)) {
    const cmd = commands.find((x) => x.id === c.id || (!c.id.includes(":") && x.name === c.id));
    if (cmd) {
      const file = join(roots().plugins, cmd.plugin, "commands");
      const name = readdirSync(/*turbopackIgnore: true*/ file).find((f) => slugOf(f.replace(/\.md$/i, "")) === cmd.name);
      const body = name ? readCommand(readFileSync(/*turbopackIgnore: true*/ join(file, name), "utf8"), name)?.body : null;
      if (body) {
        parts.push(`The user ran the command /${cmd.id}${c.args ? ` with "${c.args}"` : ""}. Do what it says:\n${fillCommand(body, c.args).slice(0, 16_000)}`);
        ids.push(cmd.id);
      }
      continue;
    }
    const skill = enabledSkills().find((s) => s.id === c.id || (!c.id.includes(":") && s.id.endsWith(`:${c.id}`)));
    const t = skill && skillText(skill.id);
    if (t) {
      parts.push(`The user asked you to use the skill /${skill.id}. Follow it for this request (and when you start a task for it, say in the task to use the skill ${skill.id}):\n${t}`);
      ids.push(skill.id);
    }
  }
  return { ids, note: parts.join("\n\n") };
}

/** The skills that are on, copied into a task's skills folder on this PC (a plugin's as "plugin-skill"). */
export function copySkillsTo(target: string) {
  let copied = 0;
  for (const s of enabledSkills()) {
    const dir = skillDir(s.id);
    if (!dir) continue;
    const to = join(target, s.id.replace(":", "-"));
    try {
      cpSync(dir, to, { recursive: true, filter: (src) => relative(dir, src) !== META });
      copied++;
    } catch {}
  }
  return copied;
}

/**
 * For a task's first turn: the skills that are on, and in full the ones its task names ("use the skill
 * weekly-report", "/sales:call-prep"), so a task on a cloud computer has them too. Empty with none on.
 */
export function taskSkills(goal: string) {
  const on = enabledSkills();
  if (!on.length) return "";
  const g = goal.toLowerCase();
  const named = on.filter((s) => {
    const short = s.id.split(":").pop()!;
    return new RegExp(`(^|[^a-z0-9-])/?(${s.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![a-z0-9-])`).test(g);
  });
  let room = 30_000;
  const full: string[] = [];
  for (const s of named.slice(0, 4)) {
    const t = skillText(s.id);
    if (!t || t.length > room) continue;
    room -= t.length;
    full.push(t);
  }
  return [skillsNote("task"), ...full].join("\n\n");
}
