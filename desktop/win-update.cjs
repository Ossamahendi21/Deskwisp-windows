/**
 * Deskwisp for Windows updates itself (desktop/win-main.cjs uses this). At launch and every hour it asks
 * deskwisp.com for the newest release, download/win/latest.json, which scripts/release-win.sh writes:
 *
 *   { "version": "0.1.0", "file": "Deskwisp-Setup-0.1.0-x64.exe", "sha512": "<base64>", "size": 123, "notes": ["…"] }
 *
 * When it's newer than this app, the installer comes down in the background into
 * %LOCALAPPDATA%\deskwisp-updater, and it's kept only if its size and SHA-512 are what latest.json says.
 * Then the page's notice (components/app/update-notice.tsx) offers "Restart": Deskwisp closes, the
 * installer runs silently over the same install (/S --updated, as electron-builder's own updater runs
 * it) and opens Deskwisp again (--force-run). Quitting with an update ready installs it too, without
 * opening it again. Your data (%APPDATA%\Deskwisp) isn't touched by an update.
 *
 * Nothing here throws or shows an error. When the download can't be had or doesn't check out, the notice
 * sends you to deskwisp.com instead, and the next hourly check tries again. What happens is logged once
 * per change, in logs\updates.log.
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
/** latest.json's notes as the notice shows them: up to five non-empty lines. */
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

/**
 * The updater, for one app: `currentVersion` (app.getVersion()), `dir` where installers go, `logFile`,
 * and `onChange(info)` when what the notice should show changes. `info()` is that: { version, notes, ready }
 * while a newer release is out (ready once its installer is here and checked), else null.
 */
function createUpdater({ currentVersion, dir, logFile, onChange = () => {}, latestUrl = LATEST_URL, fetchImpl = (...a) => fetch(...a), spawnImpl = spawn }) {
  let lastNote = "";
  let newer; // { version, notes, file, sha512, size, url }
  let ready; // the checked installer's path, for `newer`
  let checking;
  let downloading = false;

  function note(text) {
    if (text === lastNote) return;
    lastNote = text;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {}
  }

  // Nothing to show while the installer is still coming down.
  const info = () => (newer && !downloading ? { version: newer.version, notes: newer.notes, ready: !!ready } : null);
  let told = "null";
  function tell() {
    const now = JSON.stringify(info());
    if (now === told) return;
    told = now;
    onChange(info());
  }

  /** Every other file in `dir` goes: older installers, and a half-done download. */
  function tidy(keep) {
    try {
      for (const name of fs.readdirSync(dir)) if (name !== keep) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    } catch {}
  }

  async function download(release) {
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

  async function checkOnce() {
    let res;
    try {
      res = await fetchImpl(latestUrl, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return note(`couldn't check: ${e?.message ?? e}`);
    }
    if (!res.ok) return note(`couldn't check: ${latestUrl} answered ${res.status}`);
    let latest;
    try {
      latest = JSON.parse(await res.text());
    } catch {
      return note(`couldn't check: ${latestUrl} isn't JSON`);
    }
    const release = readLatest(latest, latestUrl);
    if (release.problem) return note(`couldn't check: ${release.problem}`);
    if (!isNewer(release.version, currentVersion)) {
      if (newer) (newer = undefined), (ready = undefined), tidy(undefined), tell();
      return note(`up to date (${currentVersion}, deskwisp.com has ${release.version})`);
    }
    if (ready && newer?.version === release.version && newer.sha512 === release.sha512) return;
    newer = release;
    ready = undefined;
    note(`Deskwisp ${release.version} is out (this is ${currentVersion}): downloading it`);
    downloading = true;
    try {
      ready = await download(release);
      tidy(path.basename(ready));
      note(`Deskwisp ${release.version} is ready to install`);
    } catch (e) {
      note(`couldn't download Deskwisp ${release.version}: ${e?.message ?? e}`);
    } finally {
      downloading = false;
    }
    tell();
  }

  /** Asks deskwisp.com now (one at a time: a check already going is the one waited on). */
  function check() {
    checking ??= checkOnce().finally(() => (checking = undefined));
    return checking;
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
      spawnImpl(ready, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      note(`couldn't run the installer: ${e?.message ?? e}`);
      return false;
    }
    ready = undefined;
    return true;
  }

  return { check, info, install, isReady: () => !!ready };
}

async function sha512Of(file) {
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

module.exports = { createUpdater, isNewer, readLatest, versionParts, LATEST_URL };
