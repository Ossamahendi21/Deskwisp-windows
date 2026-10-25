/**
 * Skills and plugins as files, the same format Claude and Codex use (agentskills.io): a skill is a
 * folder with a SKILL.md (front matter with `name` and `description`, then the instructions) and any
 * files it needs; a plugin is a folder with .claude-plugin/plugin.json, its skills under skills/ and
 * its commands under commands/ (one .md each, its words a prompt, $ARGUMENTS where what's typed after
 * it goes). A marketplace is a repository with .claude-plugin/marketplace.json listing its plugins.
 * No I/O here: lib/server/skill-library.ts and lib/server/skill-catalog.ts read and write the files.
 */

export type FrontMatter = Record<string, string>;

/** A SKILL.md's front matter (simple YAML: `key: value`, quoted or not, and `>` or `|` blocks) and the rest. */
export function frontMatter(text: string): { meta: FrontMatter; body: string } {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta: FrontMatter = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^"(.*)"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    meta[kv[1]] = value;
  }
  return { meta, body: t.slice(m[0].length) };
}

/** A name as a skill's folder name: lowercase letters, digits and dashes, up to 64 ("Weekly status report" → "weekly-status-report"). */
export function slugOf(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
export const isSlug = (s: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s);

/** A YAML string that's always read back as written. */
const yaml = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

/** A SKILL.md from what the user typed (Create a skill). */
export function skillMd(name: string, description: string, body: string) {
  return `---\nname: ${slugOf(name)}\ndescription: ${yaml(description)}\n---\n\n${body.replace(/\r\n/g, "\n").trim()}\n`;
}

/** A skill's SKILL.md with a new description and instructions, everything else in its front matter kept. */
export function editSkillMd(text: string, description: string, body: string) {
  const t = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  const kept = m ? m[1].split("\n") : [];
  // Drop the old description (and a block under it), put the new one in its place.
  const out: string[] = [];
  let put = false;
  for (let i = 0; i < kept.length; i++) {
    if (/^description:/.test(kept[i])) {
      while (i + 1 < kept.length && /^\s+\S/.test(kept[i + 1])) i++;
      out.push(`description: ${yaml(description)}`);
      put = true;
    } else out.push(kept[i]);
  }
  if (!put) out.push(`description: ${yaml(description)}`);
  return `---\n${out.join("\n")}\n---\n\n${body.replace(/\r\n/g, "\n").trim()}\n`;
}

/** A skill folder's front matter, checked: what a skill needs to be one. */
export function readSkill(text: string, folder: string): { name: string; description: string; body: string; license?: string } | null {
  const { meta, body } = frontMatter(text);
  const description = (meta.description ?? "").trim();
  if (!description) return null;
  const name = (meta.name ?? "").trim() || folder;
  return { name, description, body, ...(meta.license ? { license: meta.license } : {}) };
}

/** Where the skills are in a list of file paths: each folder holding a SKILL.md ("" for one at the top). */
export function skillFolders(paths: string[]) {
  return paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p)).map((p) => p.replace(/\/?SKILL\.md$/i, ""));
}

/** Files under `folder` ("" for all), with paths relative to it. */
export function within(paths: string[], folder: string) {
  if (!folder) return paths;
  const pre = `${folder}/`;
  return paths.filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length));
}

/** A command file (commands/<name>.md): what it's for, and its prompt. */
export function readCommand(text: string, file: string) {
  const { meta, body } = frontMatter(text);
  const name = slugOf(file.replace(/\.md$/i, "").split("/").pop() ?? "");
  if (!name || !body.trim()) return null;
  const description = (meta.description ?? "").trim() || body.trim().split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 160) || name;
  return { name, description, ...(meta["argument-hint"] ? { hint: meta["argument-hint"] } : {}), body: body.trim() };
}

/** A command's prompt with what was typed after it: $ARGUMENTS, $1, $2… filled in. */
export function fillCommand(body: string, args: string) {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  const filled = body.replace(/\$ARGUMENTS/g, args.trim()).replace(/\$(\d)/g, (_, n: string) => words[Number(n) - 1] ?? "");
  return /\$ARGUMENTS/.test(body) || !args.trim() ? filled : `${filled}\n\n${args.trim()}`;
}

/** What a marketplace.json says about one plugin, checked. `source` is a folder in the same repository, or another repository. */
export type MarketPlugin = {
  name: string;
  description: string;
  category?: string;
  author?: string;
  /** In the same repository: its folder ("plugins/sales"); elsewhere: the repository and its folder. */
  source: { folder: string } | { repo: string; ref?: string; folder: string };
};

/** "https://github.com/owner/repo(.git)" → "owner/repo", or null for anything not on GitHub. */
export function githubRepo(url: string) {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function readMarketplace(text: string): { name: string; plugins: MarketPlugin[] } | null {
  let j: { name?: unknown; plugins?: unknown };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    return null;
  }
  if (!Array.isArray(j.plugins)) return null;
  const plugins: MarketPlugin[] = [];
  for (const raw of j.plugins as Record<string, unknown>[]) {
    const name = typeof raw?.name === "string" ? slugOf(raw.name) : "";
    if (!name) continue;
    const description = typeof raw.description === "string" ? raw.description : "";
    const category = typeof raw.category === "string" ? raw.category : undefined;
    const author = typeof (raw.author as { name?: unknown })?.name === "string" ? ((raw.author as { name: string }).name) : undefined;
    const s = raw.source;
    let source: MarketPlugin["source"] | null = null;
    if (typeof s === "string") {
      const folder = s.replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (!folder.split("/").includes("..")) source = { folder };
    } else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const repo = o.source === "github" && typeof o.repo === "string" ? o.repo : typeof o.url === "string" ? githubRepo(o.url) : null;
      const folder = typeof o.path === "string" ? o.path.replace(/^\.\/?/, "").replace(/\/+$/, "") : "";
      const ref = typeof o.sha === "string" ? o.sha : typeof o.ref === "string" ? o.ref : undefined;
      if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !folder.split("/").includes("..")) source = { repo, folder, ...(ref ? { ref } : {}) };
    }
    if (source) plugins.push({ name, description, ...(category ? { category } : {}), ...(author ? { author } : {}), source });
  }
  return { name: typeof j.name === "string" ? j.name : "", plugins };
}

/** A plugin's own plugin.json: its name, description and version. */
export function readPluginJson(text: string, folder: string) {
  try {
    const j = JSON.parse(text) as { name?: unknown; description?: unknown; version?: unknown; author?: { name?: unknown } };
    return {
      name: slugOf(typeof j.name === "string" ? j.name : folder.split("/").pop() ?? ""),
      description: typeof j.description === "string" ? j.description : "",
      ...(typeof j.version === "string" ? { version: j.version } : {}),
      ...(typeof j.author?.name === "string" ? { author: j.author.name } : {}),
    };
  } catch {
    return null;
  }
}

/** What's in a plugin folder, from its file list: its skills, commands, and what Deskwisp can't use (MCP servers, hooks, agents). */
export function pluginParts(paths: string[]) {
  return {
    skills: skillFolders(paths).filter((f) => f === "skills" || f.startsWith("skills/")),
    commands: paths.filter((p) => /^commands\/[^/]+\.md$/i.test(p)),
    mcp: paths.includes(".mcp.json"),
    hooks: paths.some((p) => p.startsWith("hooks/")),
    agents: paths.some((p) => /^agents\/[^/]+\.md$/i.test(p)),
  };
}

/** Invocations in a message: "/name" or "/plugin:name", each with what follows it on its line. */
export function invocations(text: string) {
  const out: { id: string; args: string }[] = [];
  for (const m of text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)(?=\s|$)([^\n]*)/g)) out.push({ id: m[2], args: m[3].trim() });
  return out;
}

/** Whether a license line reads as one that lets anyone use and share the files (Apache, MIT, BSD, ISC, MPL, CC0, Unlicense). */
export function openLicense(text: string) {
  const t = text.slice(0, 600);
  if (/proprietar|all rights reserved|terms of service|developer terms/i.test(t)) return false;
  return /apache license|\bmit license|permission is hereby granted|\bbsd\b|\bisc license|mozilla public license|cc0|unlicense|apache-2\.0|^mit$/im.test(t);
}
