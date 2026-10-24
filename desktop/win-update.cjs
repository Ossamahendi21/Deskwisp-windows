/**
 * Deskwisp for Windows updates itself (desktop/win-main.cjs uses this). At launch and every hour, and
 * whenever you press "Check for updates" in About, it asks deskwisp.com for the newest release,
 * download/win/latest.json, which scripts/release-win.sh writes:
 *
 *   { "version": "0.1.0", "file": "Deskwisp-Setup-0.1.0-x64.exe", "sha512": "<base64>", "size": 123, "notes": ["…"] }
 *
 * When it's newer than this app, its installer comes down (by itself, unless you turned that off in
 * About) into %LOCALAPPDATA%\deskwisp-updater, and it's kept only if its size and SHA-512 are what
 * latest.json says. Then "Restart to update" (the sidebar's notice, About, or the update screen,
 * desktop/update.html): Deskwisp closes, the installer runs silently over the same install (/S
 * --updated, as electron-builder's own updater runs it) and opens Deskwisp again (--force-run).
 * Quitting with an update ready installs it too, without opening it again. If Deskwisp was closed
 * some other way (Windows shut down, say), the next launch finds the installer and offers it first.
 * Your data (%APPDATA%\Deskwisp) isn't touched by an update.
 *
 * Where it's at is `status()`, one of these `state`s, sent on every change (the download's progress at
 * most every quarter second):
 *   idle         not asked yet this run
 *   checking     asking deskwisp.com
 *   latest       this is the newest
 *   available    a newer one is out, not downloaded (automatic downloads are off)
 *   downloading  coming down: `progress` 0…1
 *   ready        here and checked: it can be installed
 *   error        the check or the download didn't work (`error` says which, in words for people)
 * Nothing here throws. What happens is logged once per change, in logs\updates.log.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");

const LATEST_URL = "https://deskwisp.com/download/win/latest.json";
// What the installer is called (electron-builder.win.json's artifactName): nothing else is downloaded.
const FILE = /^Deskwisp-Setup-\d+\.\d+\.\d+-x64\.exe$/;

/** "1.2.3" (a leading v and anything after the third number aside) as numbers, or null. */
function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(theirs, ours) {
  const a = versionParts(theirs);
  const b = versionParts(ours);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/** latest.json's notes as the app shows them: up to five non-empty lines. */
function releaseNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n) => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** The release latest.json describes, checked: where its installer is and what it must be, or why not. */
function readLatest(latest, latestUrl) {
  const version = String(latest?.version ?? "");
  if (!versionParts(version)) return { problem: "no version in latest.json" };
  const file = String(latest?.file ?? "");
  if (!FILE.test(file)) return { problem: `latest.json names no installer (${file || "none"})` };
  const sha512 = String(latest?.sha512 ?? "");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512)) return { problem: "latest.json has no SHA-512 for the installer" };
  const size = Number(latest?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return { problem: "latest.json has no size for the installer" };
  // Next to latest.json, on the same server: never anywhere else it might name.
  const url = new URL(file, latestUrl);
  if (url.origin !== new URL(latestUrl).origin) return { problem: "latest.json points elsewhere" };
  return { version, file, sha512, size, url: url.href, notes: releaseNotes(latest?.notes) };
}

async function sha512Of(file) {
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

/**
 * The updater, for one app: `currentVersion` (app.getVersion()), `dir` where installers go, `logFile`,
 * `auto()` whether a newer version downloads by itself, and `onChange(status)` on every change.
 */
function createUpdater({
  currentVersion,
  dir,
  logFile,
  auto = () => true,
  onChange = () => {},
  latestUrl = LATEST_URL,
  fetchImpl = (...a) => fetch(...a),
  spawnImpl = spawn,
  now = () => Date.now(),
  // Where Deskwisp runs from and its process: on Windows the installer waits for both to be gone (waitThenRun).
  platform = process.platform,
  appDir = path.dirname(process.execPath),
  pid = process.pid,
}) {
  let lastNote = "";
  let state = "idle";
  let newer; // the newer release: { version, notes, file, sha512, size, url }
  let ready; // its checked installer's path
  let progress = 0;
  let error;
  let checkedAt;
  // What this version's own release says is new in it, once deskwisp.com has said this is the newest.
  let currentNotes;
  let checking;
  let downloading;

  function note(text) {
    if (text === lastNote) return;
    lastNote = text;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {}
  }

  function status() {
    return {
      current: currentVersion,
      state,
      auto: !!auto(),
      ...(checkedAt ? { checkedAt } : {}),
      ...(currentNotes?.length ? { currentNotes } : {}),
      ...(newer && ["available", "downloading", "ready", "error"].includes(state) ? { version: newer.version, notes: newer.notes } : {}),
      ...(state === "downloading" ? { progress } : {}),
      ...(state === "error" && error ? { error } : {}),
    };
  }
  let sentAt = 0;
  function set(next, { quiet = false } = {}) {
    if (next.state !== undefined) state = next.state;
    if (next.progress !== undefined) progress = next.progress;
    if ("error" in next) error = next.error;
    // The download's progress, a few times a second at most.
    if (quiet && now() - sentAt < 250) return;
    sentAt = now();
    try {
      onChange(status());
    } catch {}
  }

  /** Every other file in `dir` goes: older installers, half-done downloads. `keep` and its .json stay. */
  function tidy(keep) {
    try {
      for (const name of fs.readdirSync(dir)) if (!keep || (name !== keep && name !== `${keep}.json`)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    } catch {}
  }

  async function fetchInstaller(release) {
    const final = path.join(dir, release.file);
    // Already here from an earlier run, and still what it should be.
    if (fs.existsSync(final) && (await sha512Of(final)) === release.sha512) return final;
    fs.mkdirSync(dir, { recursive: true });
    tidy(undefined);
    const part = `${final}.part`;
    const res = await fetchImpl(release.url, { cache: "no-store", signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`${release.url} answered ${res.status}`);
    const hash = crypto.createHash("sha512");
    let got = 0;
    const count = new Transform({
      transform(chunk, _, done) {
        got += chunk.length;
        if (got > release.size) return done(new Error("the installer is bigger than latest.json says"));
        hash.update(chunk);
        set({ progress: got / release.size }, { quiet: true });
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part));
      if (got !== release.size) throw new Error(`the installer is ${got} bytes, latest.json says ${release.size}`);
      if (hash.digest("base64") !== release.sha512) throw new Error("the installer's SHA-512 isn't the one latest.json says");
      fs.renameSync(part, final);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    return final;
  }

  /** Brings the newer version's installer down now (one download at a time). */
  function download() {
    if (!newer || ready) return Promise.resolve(!!ready);
    downloading ??= (async () => {
      const release = newer;
      note(`downloading Deskwisp ${release.version} (this is ${currentVersion})`);
      set({ state: "downloading", progress: 0, error: undefined });
      try {
        const file = await fetchInstaller(release);
        // Who it is, next to it, so a later launch can offer it (restore).
        fs.writeFileSync(`${file}.json`, JSON.stringify({ version: release.version, sha512: release.sha512, size: release.size, notes: release.notes }));
        tidy(path.basename(file));
        if (newer !== release) return false;
        ready = file;
        note(`Deskwisp ${release.version} is ready to install`);
        set({ state: "ready", progress: 1 });
        return true;
      } catch (e) {
        note(`couldn't download Deskwisp ${release.version}: ${e?.message ?? e}`);
        if (newer === release) set({ state: "error", error: "The download didn't finish. Deskwisp tries again within the hour." });
        return false;
      } finally {
        downloading = undefined;
      }
    })();
    return downloading;
  }

  async function checkOnce() {
    // While a download is on, or one is ready, there's nothing to ask: what's coming is known.
    if (state === "downloading" || state === "ready") return status();
    set({ state: "checking", error: undefined });
    const failed = (why, words = "Couldn't reach deskwisp.com. Check your internet connection and try again.") => {
      note(`couldn't check: ${why}`);
      set({ state: "error", error: words });
      return status();
    };
    let res;
    try {
      res = await fetchImpl(latestUrl, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return failed(e?.message ?? String(e));
    }
    if (!res.ok) return failed(`${latestUrl} answered ${res.status}`, "deskwisp.com didn't answer as it should. Try again in a few minutes.");
    let latest;
    try {
      latest = JSON.parse(await res.text());
    } catch {
      return failed(`${latestUrl} isn't JSON`, "deskwisp.com didn't answer as it should. Try again in a few minutes.");
    }
    const release = readLatest(latest, latestUrl);
    if (release.problem) return failed(release.problem, "deskwisp.com didn't answer as it should. Try again in a few minutes.");
    checkedAt = now();
    if (!isNewer(release.version, currentVersion)) {
      newer = undefined;
      if (release.version === currentVersion) currentNotes = release.notes;
      tidy(undefined);
      note(`up to date (${currentVersion}, deskwisp.com has ${release.version})`);
      set({ state: "latest" });
      return status();
    }
    if (newer?.version !== release.version || newer.sha512 !== release.sha512) newer = release;
    note(`Deskwisp ${release.version} is out (this is ${currentVersion})`);
    set({ state: "available" });
    if (auto()) void download();
    return status();
  }

  /** Asks deskwisp.com now, and answers with the status (one check at a time). */
  function check() {
    checking ??= checkOnce().finally(() => (checking = undefined));
    return checking;
  }

  /**
   * At launch: an installer for a newer version, downloaded and checked before Deskwisp was last closed
   * (and not installed: Windows shut it down, say), is ready again. True when there's one.
   */
  async function restore() {
    if (ready) return true;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!FILE.test(name)) continue;
        const file = path.join(dir, name);
        const kept = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
        if (!isNewer(kept.version, currentVersion) || !FILE.test(name)) continue;
        if (fs.statSync(file).size !== kept.size || (await sha512Of(file)) !== kept.sha512) continue;
        newer = { version: String(kept.version), notes: releaseNotes(kept.notes), file: name, sha512: kept.sha512, size: kept.size };
        ready = file;
        note(`Deskwisp ${newer.version} was downloaded before: ready to install`);
        set({ state: "ready", progress: 1 });
        return true;
      }
    } catch {}
    tidy(undefined);
    return false;
  }

  /**
   * Runs the ready installer, on its own: it waits for Deskwisp to close, installs over it silently and,
   * with `reopen`, opens it again. False when there's nothing to install.
   */
  function install({ reopen }) {
    if (!ready || !fs.existsSync(ready)) return false;
    const args = ["--updated", "/S", ...(reopen ? ["--force-run"] : [])];
    note(`installing Deskwisp ${newer?.version} (${reopen ? "then opening it" : "on quit"})`);
    try {
      if (platform === "win32") spawnImpl("powershell.exe", waitThenRun(ready, args), { detached: true, stdio: "ignore", windowsHide: true }).unref();
      else spawnImpl(ready, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      note(`couldn't run the installer: ${e?.message ?? e}`);
      return false;
    }
    ready = undefined;
    return true;
  }

  /**
   * PowerShell's arguments to run the installer only once Deskwisp has let go of its files: this process
   * gone, then every other one still running from its folder (its windows' helpers, the server it ran),
   * up to 30 seconds each, the last stopped if they're still there. Run straight away, the installer
   * finds them still holding their files and stops ("Failed to uninstall old application files").
   */
  function waitThenRun(installer, args) {
    const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
    const folder = appDir.endsWith("\\") ? appDir : `${appDir}\\`;
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$dir = ${q(folder)}`,
      "$mine = { Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) } }",
      `Wait-Process -Id ${Number(pid)} -Timeout 30`,
      "$until = (Get-Date).AddSeconds(30)",
      "while ((Get-Date) -lt $until -and (& $mine)) { Start-Sleep -Milliseconds 500 }",
      "& $mine | Stop-Process -Force",
      "Start-Sleep -Milliseconds 800",
      `Start-Process -FilePath ${q(installer)} -ArgumentList @(${args.map(q).join(", ")})`,
    ].join("\n");
    return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }

  return { check, download, restore, install, status, isReady: () => !!ready };
}

module.exports = { createUpdater, isNewer, readLatest, versionParts, LATEST_URL };
