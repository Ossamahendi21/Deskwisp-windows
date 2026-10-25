// Tests for skills and plugins (Skills and Plugins in the app; "/" in a chat): the archive readers
// (lib/archive.ts: tar.gz and zip, paths that climb out, links, limits), the file formats
// (lib/skills-core.ts: front matter, a SKILL.md made and changed, commands and $ARGUMENTS, marketplaces,
// licenses, "/" in a message), the user's library on disk (lib/server/skill-library.ts through
// /api/skills and /api/plugins: create, save, upload a SKILL.md, a zip of skills, a zip of a plugin,
// on and off, remove, the "/" menu, what a bot is told and given) and Discover
// (lib/server/skill-catalog.ts through /api/library: a library read from GitHub's archive of it, only
// skills free to use listed, a marketplace's plugins with something Deskwisp can use, "+" copies one,
// a repository the user adds, one that has nothing). GitHub is a fake serving archives made here:
// nothing reaches the network.
// Usage: node --conditions=react-server scripts/test-skills.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(DESKWISP|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|HORAFIRM|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.DESKWISP_SELF_HOSTED = "1";
process.env.DESKWISP_HORAFIRM_ORIGIN = "https://horafirm.test";
process.env.OPENAI_API_KEY = "sk-test-skills";
globalThis.deskwispHorafirmKey = "sk_horafirm_test_skills";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "deskwisp-test-skills-"));
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that would start processes when loaded are stand-ins whose exports do nothing (as in test-crm.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});

/* ---------------- Files and archives made here ---------------- */

const write = (base, files) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), text);
  }
};
const APACHE = "                                 Apache License\n                           Version 2.0, January 2004\n";
const skill = (name, description, body = "Do the thing.", extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\n${body}\n`;
/** A repository as GitHub's archive of it: everything under "<repo>-<commit>/". */
const SHA = "0123456789abcdef0123456789abcdef01234567";
function repoArchive(name, files) {
  const d = join(scratch, "repos", `${name}-${SHA}`);
  rmSync(d, { recursive: true, force: true });
  write(d, files);
  return execFileSync("tar", ["czf", "-", "-C", dirname(d), `${name}-${SHA}`]);
}
function zipOf(files, { prefix = "" } = {}) {
  const d = mkdtempSync(join(scratch, "zip-"));
  write(join(d, prefix || "."), files);
  const out = join(scratch, `${Math.random().toString(36).slice(2)}.zip`);
  execFileSync("zip", ["-qr", out, "."], { cwd: d });
  return readFileSync(out);
}

const SKILLS_REPO = repoArchive("skills", {
  "README.md": "Skills",
  "skills/brand/SKILL.md": skill("brand-guidelines", "Use for anything with our brand's colors and type."),
  "skills/brand/LICENSE.txt": APACHE,
  "skills/brand/assets/colors.json": '{"ink":"#16132B"}',
  "skills/pdf/SKILL.md": skill("pdf", "Anything with PDF files.", "Read them.", "license: Proprietary. LICENSE.txt has complete terms\n"),
  "skills/pdf/LICENSE.txt": "© Someone. All rights reserved. Proprietary.",
  "skills/no-license/SKILL.md": skill("no-license", "Has no license anywhere."),
  "skills/broken/SKILL.md": "# no front matter",
  "spec/SKILL.md": skill("outside", "Outside the library's folder."),
  "spec/LICENSE.txt": APACHE,
});
const PLUGINS_REPO = repoArchive("plugins", {
  LICENSE: APACHE,
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "work",
    plugins: [
      { name: "sales", description: "Sales work.", source: "./sales", category: "sales" },
      { name: "lsp-only", description: "Only a language server.", source: "./lsp-only" },
      { name: "elsewhere", description: "In another repository.", source: { source: "url", url: "https://github.com/someone/else.git" } },
      { name: "../climb", description: "Bad.", source: "../../etc" },
    ],
  }),
  "sales/.claude-plugin/plugin.json": JSON.stringify({ name: "sales", description: "Sales work.", version: "2.1.0", author: { name: "Anthropic" } }),
  "sales/skills/call-prep/SKILL.md": skill("call-prep", "Prep a sales call."),
  "sales/skills/forecast/SKILL.md": skill("forecast", "Write the forecast."),
  "sales/commands/brief.md": "---\ndescription: A brief on an account\nargument-hint: <company>\n---\nWrite a one-page brief on $ARGUMENTS.",
  "sales/.mcp.json": "{}",
  "lsp-only/.claude-plugin/plugin.json": JSON.stringify({ name: "lsp-only" }),
  "lsp-only/.lsp.json": "{}",
  "loose/SKILL.md": skill("loose", "A skill at the top of a plugin repository."),
});
const EMPTY_REPO = repoArchive("empty", { "README.md": "Nothing here" });

/* ---------------- GitHub: a fake ---------------- */

const archives = { "acme/skills": SKILLS_REPO, "acme/plugins": PLUGINS_REPO, "acme/empty": EMPTY_REPO };
const asked = [];
/** Each chat model call (its body); the answer is always "Done." */
const modelAsked = [];
const github = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    modelAsked.push(JSON.parse(await new Request(input, init).text()));
    const said = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    return new Response(JSON.stringify({ id: `resp_${modelAsked.length}`, object: "response", model: "gpt-test", status: "completed", output: [said], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.origin === "https://horafirm.test") return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
  asked.push(url.href);
  const m = /^\/([\w.-]+\/[\w.-]+)\/archive\/([^/]+)\.tar\.gz$/.exec(url.pathname);
  if (url.host !== "github.com" || !m) throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  const a = archives[m[1]];
  return a ? new Response(a, { status: 200, headers: { "content-length": String(a.length) } }) : new Response("Not Found", { status: 404 });
};
globalThis.fetch = github;

const A = await import(`${root}/lib/archive.ts`);
const C = await import(`${root}/lib/skills-core.ts`);
const L = await import(`${root}/lib/server/skill-library.ts`);
const G = await import(`${root}/lib/server/skill-catalog.ts`);
const SkillsApi = await import(`${root}/app/api/skills/route.ts`);
const PluginsApi = await import(`${root}/app/api/plugins/route.ts`);
const LibraryApi = await import(`${root}/app/api/library/route.ts`);

const call = async (handler, method, path, body) => {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) Object.assign(init, { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await handler(new Request(`http://localhost:3210${path}`, init));
  return { status: res.status, body: await res.json() };
};
const upload = (name, data) => {
  const f = new FormData();
  f.append("file", new File([data], name));
  return call(SkillsApi.POST, "POST", "/api/skills", f);
};
const noDashes = (text) => assert.ok(!/[–—]/.test(String(text)), `no dashes: ${text}`);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${e.stack}`);
  }
}

/* ---------------- Archives ---------------- */

await test("tar.gz: files with their paths, long names, nothing outside", () => {
  const long = `${"deep/".repeat(30)}file.md`;
  const tgz = repoArchive("t", { "a.md": "A", [long]: "L", "b/c.txt": "C" });
  const files = A.readTarGz(tgz);
  const byPath = Object.fromEntries(files.map((f) => [f.path.split("/").slice(1).join("/"), f.data.toString()]));
  assert.equal(byPath["a.md"], "A");
  assert.equal(byPath["b/c.txt"], "C");
  assert.equal(byPath[long], "L", "a path over 100 characters (pax or GNU long name)");
  assert.equal(A.cleanPath("../x"), null);
  assert.equal(A.cleanPath("a/../../x"), null);
  assert.equal(A.cleanPath("/etc/passwd"), "etc/passwd");
  assert.equal(A.cleanPath("C:\\x\\y"), null);
  assert.equal(A.cleanPath("a\\b/./c"), "a/b/c");
});

await test("zip: stored and deflated, folders and links left out, limits", () => {
  const z = zipOf({ "s/SKILL.md": skill("s", "S."), "s/big.txt": "x".repeat(50_000) });
  const files = A.readZip(z);
  assert.deepEqual(files.map((f) => f.path).sort(), ["s/SKILL.md", "s/big.txt"]);
  assert.equal(files.find((f) => f.path === "s/big.txt").data.length, 50_000);
  assert.throws(() => A.readZip(z, { maxFiles: 1, maxFileBytes: 1e6, maxTotalBytes: 1e9 }), /too big/);
  assert.equal(A.readZip(z, { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 1e9 }).length, 1, "a file over its limit is left out");
  // A symlink inside a zip doesn't come out as a file.
  const d = mkdtempSync(join(scratch, "ln-"));
  writeFileSync(join(d, "real.md"), "R");
  execFileSync("ln", ["-s", "/etc/passwd", join(d, "link")]);
  const out = join(scratch, "ln.zip");
  execFileSync("zip", ["-qry", out, "."], { cwd: d });
  assert.deepEqual(A.readZip(readFileSync(out)).map((f) => f.path), ["real.md"]);
  assert.throws(() => A.readArchive(Buffer.from("hello there, not an archive at all")), /isn't a \.zip/);
});

/* ---------------- Formats ---------------- */

await test("front matter, a SKILL.md made and changed", () => {
  const { meta, body } = C.frontMatter('---\nname: "x"\ndescription: >\n  Folded\n  over lines\nlicense: \'MIT\'\n---\nBody\n');
  assert.deepEqual(meta, { name: "x", description: "Folded over lines", license: "MIT" });
  assert.equal(body, "Body\n");
  assert.equal(C.slugOf("Weekly Status Report!"), "weekly-status-report");
  assert.equal(C.slugOf("Café déjà vu"), "cafe-deja-vu");
  const md = C.skillMd("Weekly status report", 'Use for "status" updates:\nweekly.', "Wins, blockers, next steps.");
  const read = C.readSkill(md, "x");
  assert.deepEqual({ ...read, body: read.body.trim() }, { name: "weekly-status-report", description: 'Use for "status" updates: weekly.', body: "Wins, blockers, next steps." });
  const edited = C.editSkillMd("---\nname: a\ndescription: >\n  old\n  text\nlicense: MIT\n---\nOld body", "New: one", "New body");
  assert.deepEqual(C.frontMatter(edited).meta, { name: "a", description: "New: one", license: "MIT" });
  assert.equal(C.frontMatter(edited).body.trim(), "New body");
  assert.equal(C.readSkill("# no front matter", "x"), null);
});

await test("commands, marketplaces, licenses, and \"/\" in a message", () => {
  const c = C.readCommand("---\ndescription: Brief\n---\nBrief on $ARGUMENTS, then $1.", "commands/Brief.md");
  assert.equal(c.name, "brief");
  assert.equal(C.fillCommand(c.body, "Acme Corp"), "Brief on Acme Corp, then Acme.");
  assert.equal(C.fillCommand("Do it.", "now"), "Do it.\n\nnow", "what's typed goes after a prompt with no $ARGUMENTS");
  const m = C.readMarketplace(readFileSync(join(scratch, "repos", `plugins-${SHA}`, ".claude-plugin/marketplace.json"), "utf8"));
  assert.deepEqual(m.plugins.map((p) => [p.name, p.source]), [
    ["sales", { folder: "sales" }],
    ["lsp-only", { folder: "lsp-only" }],
    ["elsewhere", { repo: "someone/else", folder: "" }],
  ]);
  assert.equal(C.openLicense(APACHE), true);
  assert.equal(C.openLicense("Proprietary. LICENSE.txt has complete terms"), false);
  assert.equal(C.openLicense("governed by the Figma Developer Terms"), false);
  assert.deepEqual(C.invocations("/weekly-report for Acme\nand /sales:brief Acme Corp\nnot a/path or http://x/y"), [
    { id: "weekly-report", args: "for Acme" },
    { id: "sales:brief", args: "Acme Corp" },
  ]);
});

/* ---------------- The user's skills ---------------- */

await test("create, list, read, save, the \"/\" menu, on and off, remove", async () => {
  let r = await call(SkillsApi.POST, "POST", "/api/skills", { action: "create", name: "Weekly status report", description: "Use for weekly updates.", body: "Wins, blockers, next steps." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, "weekly-status-report");
  r = await call(SkillsApi.POST, "POST", "/api/skills", { action: "create", name: "Weekly status report", description: "Again.", body: "Again." });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already/);
  r = await call(SkillsApi.POST, "POST", "/api/skills", { action: "create", name: "x", description: "", body: "y" });
  assert.match(r.body.error, /what the skill is for/);
  r = await call(SkillsApi.GET, "GET", "/api/skills?id=weekly-status-report");
  assert.equal(r.body.skill.body, "Wins, blockers, next steps.");
  assert.deepEqual(r.body.skill.source, { kind: "created" });
  r = await call(SkillsApi.POST, "POST", "/api/skills", { action: "save", id: "weekly-status-report", description: "Use for Monday updates.", body: "Only wins." });
  r = await call(SkillsApi.GET, "GET", "/api/skills?id=weekly-status-report");
  assert.equal(r.body.skill.description, "Use for Monday updates.");
  assert.equal(r.body.skill.body, "Only wins.");
  r = await call(SkillsApi.GET, "GET", "/api/skills?menu=1");
  assert.deepEqual(r.body.skills.map((s) => s.id), ["weekly-status-report"]);
  assert.match(L.skillsNote("chat"), /weekly-status-report: Use for Monday updates\./);
  await call(SkillsApi.POST, "POST", "/api/skills", { action: "toggle", id: "weekly-status-report", enabled: false });
  assert.equal((await call(SkillsApi.GET, "GET", "/api/skills?menu=1")).body.skills.length, 0, "off: not in the menu");
  assert.equal(L.skillsNote("chat"), "", "off: the bots aren't told");
  await call(SkillsApi.POST, "POST", "/api/skills", { action: "toggle", id: "weekly-status-report", enabled: true });
  const inv = L.invokedNote("Please /weekly-status-report for this week");
  assert.deepEqual(inv.ids, ["weekly-status-report"]);
  assert.match(inv.note, /Only wins\./);
  assert.equal(L.invokedNote("/nothing-like-it here").note, "");
});

await test("upload: a SKILL.md, a zip of skills, a zip of a plugin; bad ones say why", async () => {
  let r = await upload("SKILL.md", skill("invoice-chaser", "Use to chase unpaid invoices."));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.addedSkills, ["invoice-chaser"]);
  r = await upload("notes.md", "# just notes");
  assert.match(r.body.error, /front matter/);
  r = await upload("two.zip", zipOf({ "a/SKILL.md": skill("alpha", "A."), "a/ref.md": "ref", "b/SKILL.md": skill("beta", "B."), "b/nested/SKILL.md": skill("gamma", "G.") }));
  assert.deepEqual(r.body.addedSkills.sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual((await call(SkillsApi.GET, "GET", "/api/skills?id=alpha")).body.skill.files, ["ref.md"]);
  assert.deepEqual((await call(SkillsApi.GET, "GET", "/api/skills?id=beta")).body.skill.files, [], "a skill nested in another isn't part of it");
  r = await upload("plugin.zip", zipOf({ ".claude-plugin/plugin.json": JSON.stringify({ name: "Ops Kit", description: "Ops." }), "skills/standup/SKILL.md": skill("standup", "Daily standup."), "commands/ship.md": "Ship $ARGUMENTS today." }, { prefix: "ops-kit" }));
  assert.equal(r.body.plugin, "ops-kit", JSON.stringify(r.body));
  r = await call(PluginsApi.GET, "GET", "/api/plugins");
  assert.deepEqual(r.body.plugins.map((p) => [p.name, p.skills, p.commands]), [["ops-kit", ["standup"], ["ship"]]]);
  const menu = (await call(SkillsApi.GET, "GET", "/api/skills?menu=1")).body;
  assert.ok(menu.skills.some((s) => s.id === "ops-kit:standup"));
  assert.deepEqual(menu.commands.map((c) => c.id), ["ops-kit:ship"]);
  assert.match(L.invokedNote("/ops-kit:ship the new pricing page").note, /Ship the new pricing page today\./);
  r = await upload("empty.zip", zipOf({ "readme.txt": "no skills" }));
  assert.match(r.body.error, /no skill in that file/);
  r = await upload("plugin2.zip", zipOf({ ".claude-plugin/plugin.json": JSON.stringify({ name: "hooks-only" }), "hooks/hooks.json": "{}" }));
  assert.match(r.body.error, /no skills or commands/);
  r = await call(SkillsApi.POST, "POST", "/api/skills", { action: "remove", id: "ops-kit:standup" });
  assert.match(r.body.error, /remove the plugin/);
  await call(PluginsApi.POST, "POST", "/api/plugins", { action: "toggle", name: "ops-kit", enabled: false });
  assert.ok(!(await call(SkillsApi.GET, "GET", "/api/skills?menu=1")).body.skills.some((s) => s.plugin), "a plugin that's off: its skills and commands aren't in the menu");
  await call(PluginsApi.POST, "POST", "/api/plugins", { action: "remove", name: "ops-kit" });
  assert.deepEqual((await call(PluginsApi.GET, "GET", "/api/plugins")).body.plugins, []);
});

await test("a task on the PC gets the skills that are on, in its skills folder", () => {
  const to = join(scratch, "task-skills");
  mkdirSync(to);
  const n = L.copySkillsTo(to);
  assert.ok(n >= 4);
  assert.ok(existsSync(join(to, "alpha", "SKILL.md")) && existsSync(join(to, "alpha", "ref.md")));
  assert.ok(!existsSync(join(to, "alpha", ".deskwisp.json")), "Deskwisp's own note about it stays home");
});

/* ---------------- Discover ---------------- */

await test("libraries: free skills listed, plugins with something to use, \"+\" copies one", async () => {
  // Only the fake's libraries, not the real ones (those would reach GitHub).
  G.LIBRARIES.splice(0, G.LIBRARIES.length, { id: "acme/skills", repo: "acme/skills", folder: "skills", name: "Acme skills", builtIn: true }, { id: "acme/plugins", repo: "acme/plugins", name: "Acme plugins", builtIn: true });
  let r = await call(LibraryApi.GET, "GET", "/api/library");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.skills.map((s) => s.name).sort(), ["brand-guidelines", "loose"], "the proprietary one, one with no license and one outside the folder aren't listed");
  assert.deepEqual(r.body.plugins.map((p) => [p.name, p.skills, p.commands, p.unused]), [["sales", 2, 1, ["MCP"]]]);
  assert.ok(r.body.libraries.every((l) => !l.error));
  const before = asked.length;
  r = await call(LibraryApi.GET, "GET", "/api/library");
  assert.equal(asked.length, before, "read again within the day: from what's kept");
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-skill", library: "acme/skills", folder: "skills/brand" });
  assert.equal(r.body.id, "brand-guidelines", JSON.stringify(r.body));
  const s = (await call(SkillsApi.GET, "GET", "/api/skills?id=brand-guidelines")).body.skill;
  assert.deepEqual(s.files, ["LICENSE.txt", "assets/colors.json"]);
  assert.deepEqual(s.source, { kind: "library", repo: "acme/skills", path: "skills/brand", library: "acme/skills", ref: SHA });
  r = await call(LibraryApi.GET, "GET", "/api/library");
  assert.equal(r.body.skills.find((x) => x.name === "brand-guidelines").added, true);
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-plugin", library: "acme/plugins", folder: "sales" });
  assert.equal(r.body.name, "sales", JSON.stringify(r.body));
  assert.deepEqual(r.body.plugins[0].unused, ["its own app connections (MCP)"]);
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-skill", library: "acme/skills", folder: "skills/pdf" });
  assert.match(r.body.error, /isn't in the library/, "a skill that isn't listed can't be added by asking");
});

await test("a repository the user adds: read at once; one with nothing, or not there, says so", async () => {
  let r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-library", url: "https://github.com/acme/empty" });
  assert.match(r.body.error, /no skills or plugins/);
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-library", url: "acme/missing" });
  assert.match(r.body.error, /no public repository/);
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-library", url: "not a repo" });
  assert.match(r.body.error, /GitHub repository/);
  archives["me/mine"] = repoArchive("mine", { LICENSE: "MIT License\n\nPermission is hereby granted, free of charge", "SKILL.md": skill("my-skill", "Mine.") });
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "add-library", url: "https://github.com/me/mine.git" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.skills.some((s) => s.library === "me/mine" && s.name === "my-skill"));
  assert.deepEqual(G.parseLibrary("https://github.com/o/r/tree/main/skills/x"), { id: "o/r/skills/x", repo: "o/r", ref: "main", folder: "skills/x", name: "o/r/skills/x" });
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "remove-library", id: "me/mine" });
  assert.ok(!r.body.skills.some((s) => s.library === "me/mine"));
  r = await call(LibraryApi.POST, "POST", "/api/library", { action: "remove-library", id: "acme/skills" });
  assert.match(r.body.error, /built-in/);
});

await test("a chat turn: an attached CSV is read, a PDF goes as a PDF, \"/skill\" brings its instructions", async () => {
  const U = await import(`${root}/lib/server/uploads.ts`);
  const Chat = await import(`${root}/lib/server/chat.ts`);
  const { botChatId } = await import(`${root}/lib/types.ts`);
  const csv = U.saveFile("invoices.csv", "text/csv", Buffer.from("Name,Amount\nAcme,1200\n"));
  const pdf = U.saveFile("../../quote.pdf", "application/pdf", Buffer.from("%PDF-1.4 pretend"));
  const bin = U.saveFile("model.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("PK\x03\x04 pretend"));
  assert.equal(pdf.name, "quote.pdf", "no folders in a file's name");
  assert.equal(U.fileOf("fil_../../x"), null);
  const before = modelAsked.length;
  await Chat.handleMessage(botChatId("wispy"), "/brand-guidelines total these please", undefined, undefined, undefined, undefined, undefined, undefined, [csv, pdf, bin]);
  assert.ok(modelAsked.length > before, "the bot was asked");
  // The chat's own call (others before it ask small questions, like whether memory would help).
  const turn = modelAsked.slice(before).find((m) => Array.isArray(m.tools) && m.tools.some((t) => t.name === "start_task"));
  assert.ok(turn, "the chat turn was asked");
  const body = JSON.stringify(turn.input);
  assert.match(body, /Acme,1200/, "the CSV's words");
  assert.match(body, /"input_file"/, "the PDF as a file");
  assert.match(body, /model\.xlsx/, "the spreadsheet by name");
  assert.match(body, /use the skill \/brand-guidelines/, "the skill named with /");
  assert.match(turn.instructions, /Your skills/, "the skills that are on, in the instructions");
  assert.ok(turn.tools.some((t) => t.name === "read_skill"));
});

await test("a task's first turn names the skills, with the one it's asked to use in full", () => {
  const t = L.taskSkills("Make the deck. Use the skill brand-guidelines for the colors.");
  assert.match(t, /Your skills/);
  assert.match(t, /Skill brand-guidelines:/);
  assert.doesNotMatch(L.taskSkills("Write a quick note."), /Skill brand-guidelines:/);
});

await test("what the user sees has no dashes", () => {
  for (const f of ["lib/server/skill-library.ts", "lib/server/skill-catalog.ts", "app/api/skills/route.ts", "app/api/library/route.ts", "app/api/plugins/route.ts"]) {
    for (const m of readFileSync(join(root, f), "utf8").matchAll(/(?:Error|error:)\(?\s*["`]([^"`]+)["`]/g)) noDashes(m[1]);
  }
  const listed = readdirSync(join(work, ".data"));
  assert.ok(listed.length > 0);
});

rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
// Timers the chat turn left (typing, memory) would keep it running.
process.exit(0);
