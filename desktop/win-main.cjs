/**
 * Deskwisp for Windows (desktop/main.cjs is the original Mac app). A window around the Deskwisp app:
 * it starts the app's local server with Electron's own Node, waits for it, then opens the app. Its
 * files live in %APPDATA%\Deskwisp: data\ (the server's state and the sealed vault), .env.local (your own
 * settings and keys, when self-hosting), window-token, and logs\.
 *
 * It answers the same bridge the PC app does (desktop/preload.cjs), with what Windows has: the
 * screens through desktopCapturer, notifications, a restart. PC-only parts (Full access, Automation,
 * the relay through this PC) answer as not there.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, Notification, screen, session, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createUpdater } = require("./win-update.cjs");

const PORT = Number(process.env.DESKWISP_PORT) || 3210;
/**
 * Deskwisp's own servers on deskwisp.com (docs/DEPLOY.md): accounts, computers and billing at
 * app.deskwisp.com (dcloud/), the services at cloud.deskwisp.com/api (cloud/). Never Horafirm's. A line
 * in %APPDATA%\Deskwisp\.env.local points the app elsewhere (a server on this PC, say).
 */
const HOSTED = { DESKWISP_HORAFIRM_ORIGIN: "https://app.deskwisp.com", DESKWISP_CLOUD_URL: "https://cloud.deskwisp.com/api" };
const URL = `http://localhost:${PORT}`;
const LOCAL = `http://127.0.0.1:${PORT}`;
app.commandLine.appendSwitch("host-resolver-rules", `MAP localhost:${PORT} 127.0.0.1:${PORT}`);

const ICON = path.join(__dirname, "icon.png");
const SPLASH = path.join(__dirname, "splash.html");
const TROUBLE = path.join(__dirname, "trouble.html");
const REPO = path.resolve(__dirname, "..");

let server;
let mainWin;
let pipWin;
let leaving = false;
let serverEnded;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("uncaughtException", (e) => mainLog(`uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => mainLog(`unhandled: ${e?.stack ?? e}`));

function mainLog(text) {
  try {
    fs.mkdirSync(app.getPath("logs"), { recursive: true });
    const file = path.join(app.getPath("logs"), "main.log");
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) fs.writeFileSync(file, "");
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

// ---------------------------------------------------------------- The window's token (lib/server/ui-token.ts)

let token;
function windowToken() {
  if (token) return token;
  const file = path.join(app.getPath("userData"), "window-token");
  try {
    const kept = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(kept)) return (token = kept);
  } catch {}
  token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
const giveWindowToken = () => session.defaultSession.cookies.set({ url: URL, name: "deskwisp_window", value: windowToken(), httpOnly: true, sameSite: "strict" });

// ---------------------------------------------------------------- The server

/** A release build carries Next's standalone server in resources\server; a build from the source folder runs `next dev`. */
const packagedDir = () => {
  const dir = path.join(process.resourcesPath, "server");
  return app.isPackaged && fs.existsSync(path.join(dir, "server.js")) ? dir : null;
};

/** Your settings for this PC: %APPDATA%\Deskwisp\.env.local (KEY=value lines). */
function userEnv() {
  try {
    return require("node:util").parseEnv(fs.readFileSync(path.join(app.getPath("userData"), ".env.local"), "utf8"));
  } catch {
    return {};
  }
}

function portTaken() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(true)));
  });
}

/** Whether our own server answers: it proves it was started with this window's token (app/api/health). */
async function ours() {
  const nonce = crypto.randomBytes(16).toString("hex");
  try {
    const res = await fetch(`${LOCAL}/api/health?nonce=${nonce}`, { signal: AbortSignal.timeout(1500) });
    const h = await res.json().catch(() => null);
    if (!res.ok || !h?.deskwisp) return { up: true, mine: false };
    if (!packagedDir()) return { up: true, mine: true };
    const want = crypto.createHmac("sha256", windowToken()).update(nonce).digest("hex");
    return { up: true, mine: h.proof === want };
  } catch {
    return { up: false };
  }
}

function spawnServer() {
  const dir = packagedDir();
  const env = userEnv();
  const data = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  const logFile = path.join(app.getPath("logs"), "server.log");
  const big = (fs.statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024;
  const log = fs.openSync(logFile, big ? "w" : "a");
  fs.writeSync(log, `\n--- Deskwisp ${VERSION} (Windows) starting, ${new Date().toISOString()}\n`);
  const common = {
    ...HOSTED,
    ...process.env,
    DESKWISP_WEBRTC: "0",
    ...env,
    DESKWISP_DATA_DIR: env.DESKWISP_DATA_DIR || data,
    DESKWISP_UI_TOKEN: windowToken(),
    PORT: String(PORT),
    HOSTNAME: env.DESKWISP_LISTEN_ALL === "1" ? "0.0.0.0" : "127.0.0.1",
  };
  serverEnded = undefined;
  const child = dir
    ? spawn(process.execPath, [path.join(dir, "server.js")], {
        cwd: dir,
        env: { ...common, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" },
        stdio: ["ignore", log, log],
        windowsHide: true,
      })
    : spawn("npx", ["next", "dev", "--port", String(PORT), "-H", "127.0.0.1"], { cwd: REPO, env: common, stdio: ["ignore", log, log], shell: true, windowsHide: true });
  fs.closeSync(log);
  server = child;
  child.once("error", (e) => {
    serverEnded = `couldn't start: ${e.message}`;
    mainLog(`server ${serverEnded}`);
    if (server === child) server = undefined;
  });
  child.once("exit", (code, signal) => {
    if (server !== child) return;
    serverEnded = signal ? `stopped by ${signal}` : `exited with code ${code}`;
    server = undefined;
    mainLog(`server (pid ${child.pid}) ${serverEnded}`);
    if (!leaving && mainWin && !mainWin.isDestroyed()) void openApp(mainWin);
  });
}

/** Has our server answering, or says why not. */
async function ensureServer() {
  const started = Date.now();
  let spawned = 0;
  for (;;) {
    if (leaving) return { ok: false, reason: "error", detail: "Deskwisp is quitting" };
    const who = await ours();
    if (who.up && who.mine) {
      mainLog(`server answering after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return { ok: true };
    }
    // Our own `next dev` answers before it has compiled the health route (a 404 while it builds, or
    // after a pull left its cache behind): it's ours while it runs, so wait for it. Another program on
    // the port makes ours exit (it can't listen), and then it's someone else's.
    if (who.up && !(server && !packagedDir())) return { ok: false, reason: "port-taken", detail: `another program answers on port ${PORT}` };
    if (!(await portTaken()) && !server) {
      if (spawned >= 2) return { ok: false, reason: "server-ended", detail: serverEnded };
      spawned++;
      mainLog(spawned === 1 ? "starting the server" : `starting the server again (it ${serverEnded ?? "stopped"})`);
      spawnServer();
    }
    // `next dev` compiles on its first request: give it longer.
    if (Date.now() - started > (packagedDir() ? 90_000 : 240_000))
      return {
        ok: false,
        reason: "server-slow",
        // A `next dev` that answers but never finds its own routes has a build cache from other files.
        detail: who.up && !packagedDir() ? "the server answers but can't find its pages: delete the .next folder in the source folder, then try again" : serverEnded,
      };
    await sleep(500);
  }
}

/** Ends the server and what it started (the bots' Chromes): it saves first when it can (POST /api/restart). */
async function stopServer({ save = true } = {}) {
  const child = server;
  if (!child?.pid) return;
  server = undefined;
  if (save)
    try {
      await fetch(`${LOCAL}/api/restart`, { method: "POST", headers: { "x-deskwisp-window": windowToken() }, signal: AbortSignal.timeout(8000) });
    } catch {}
  await new Promise((r) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => r(null)));
}

// ---------------------------------------------------------------- The window

let opening;
let offeredUpdate = false;
function openApp(win, { skipUpdate = false } = {}) {
  opening ??= (async () => {
    try {
      // A newer version downloaded before Deskwisp was last closed, and not installed (Windows shut it
      // down, say): offered first, once a launch (desktop/update.html). "Later" comes back here.
      if (!skipUpdate && !offeredUpdate) {
        offeredUpdate = true;
        if (updatesOn() && (await updater.restore().catch(() => false))) {
          const { version } = updater.status();
          mainLog(`offering the update to ${version} downloaded before`);
          return void (await win.loadFile(UPDATE_PAGE, { query: { phase: "ready", version } }).catch(() => {}));
        }
      }
      // The splash while the server starts, but never waited on for long: the server starts regardless.
      await Promise.race([win.loadFile(SPLASH).catch(() => {}), sleep(3000)]);
      mainLog("checking the server");
      const result = await ensureServer().catch((e) => ({ ok: false, reason: "error", detail: e?.message ?? String(e) }));
      if (win.isDestroyed()) return;
      if (!result.ok) {
        mainLog(`showing trouble: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
        return void win.loadFile(TROUBLE, { query: { reason: result.reason, detail: result.detail ?? "", logs: app.getPath("logs") } }).catch(() => {});
      }
      await giveWindowToken();
      await win.loadURL(URL).catch((e) => mainLog(`the app's page didn't load: ${e?.message ?? e}`));
    } finally {
      opening = undefined;
    }
  })();
  return opening;
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return void createWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 600,
    title: "Deskwisp",
    // The page draws its own title bar (components/app/deskwisp-app.tsx); Windows' buttons sit over its right end.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#F7F7F6", symbolColor: "#3A3A38", height: 44 },
    backgroundColor: "#FFFFFF",
    icon: ICON,
    webPreferences: { webviewTag: true, preload: path.join(__dirname, "preload.cjs") },
  });
  mainWin = win;
  mainLog("window made");
  // Not closed halfway through Restart to update: it ends by itself in a few seconds.
  win.on("close", (e) => installing && e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Web pages in the browser, and an email to support (About) in the mail app.
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", (_, d) => {
    if (leaving || d.reason === "clean-exit" || d.reason === "launch-failed") return;
    mainLog(`the window's page crashed: ${d.reason}`);
    setTimeout(() => void openApp(win), 1000);
  });
  void openApp(win);
}

/**
 * Right-click, as anywhere else on Windows (Electron has no menu of its own): in a text box Cut, Copy,
 * Paste and Select all (with spelling fixes for a word underlined in red), on selected text Copy, on a
 * link Copy link, on a picture Copy image. In the app's window and in the pages it shows.
 */
function contextMenu(contents, p) {
  const items = [];
  if (p.isEditable && p.misspelledWord) {
    for (const word of (p.dictionarySuggestions ?? []).slice(0, 5)) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
    items.push({ label: "Add to dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: "separator" });
  }
  if (p.isEditable) {
    const f = p.editFlags ?? {};
    items.push(
      { label: "Undo", role: "undo", enabled: !!f.canUndo },
      { label: "Redo", role: "redo", enabled: !!f.canRedo },
      { type: "separator" },
      { label: "Cut", role: "cut", enabled: !!f.canCut },
      { label: "Copy", role: "copy", enabled: !!f.canCopy },
      { label: "Paste", role: "paste", enabled: f.canPaste !== false },
      { label: "Paste as plain text", role: "pasteAndMatchStyle", enabled: f.canPaste !== false },
      { type: "separator" },
      { label: "Select all", role: "selectAll", enabled: f.canSelectAll !== false },
    );
  } else if (p.selectionText?.trim()) items.push({ label: "Copy", role: "copy" });
  if (p.linkURL && /^(https?|mailto):/i.test(p.linkURL)) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: "Copy link", click: () => require("electron").clipboard.writeText(p.linkURL) });
  }
  if (p.mediaType === "image" && p.hasImageContents !== false) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: "Copy image", click: () => contents.copyImageAt(p.x, p.y) });
  }
  if (!items.length) return;
  const host = contents.hostWebContents ?? contents;
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(host) ?? undefined });
}
app.on("web-contents-created", (_, contents) => {
  contents.on("context-menu", (_e, p) => contextMenu(contents, p));
});

app.on("web-contents-created", (_, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

// ---------------------------------------------------------------- The bridge (desktop/preload.cjs)

ipcMain.handle("startup-retry", () => mainWin && !mainWin.isDestroyed() && openApp(mainWin));
ipcMain.handle("startup-logs", () => shell.openPath(app.getPath("logs")));

/** Your PC's screens, to show live (the "Your PC" tab). Windows asks nothing for this. */
ipcMain.handle("mac-screens", async () => {
  const displays = screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || (d.internal ? "Built-in display" : `Display ${i + 1}`),
    width: d.size.width,
    height: d.size.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
  const win = BrowserWindow.getAllWindows()[0];
  const deskwispOn = win ? String(screen.getDisplayMatching(win.getBounds()).id) : undefined;
  const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
  return { access: "granted", displays, deskwispOn, sources: list.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id || undefined })) };
});
ipcMain.handle("mac-screen-settings", () => shell.openExternal("ms-settings:privacy"));

const notifyStatus = () => (Notification.isSupported() ? "granted" : "restricted");
ipcMain.handle("perm-status", () => ({
  screen: "granted",
  microphone: "granted",
  notifications: notifyStatus(),
  accessibility: "granted",
  fullDisk: "granted",
  automation: "granted",
}));
ipcMain.handle("perm-automation-apps", () => null);
ipcMain.handle("perm-request", (_, id) => (id === "notifications" ? notifyStatus() : "granted"));
ipcMain.handle("perm-settings", (_, id) =>
  shell.openExternal(id === "microphone" ? "ms-settings:privacy-microphone" : id === "notifications" ? "ms-settings:notifications" : "ms-settings:privacy"),
);
ipcMain.handle("perm-screen-restart", () => false);

let restarting;
ipcMain.handle("relaunch", () => {
  restarting ??= (async () => {
    mainLog("Restart Deskwisp");
    leaving = true;
    await stopServer();
    for (let i = 0; i < 28 && (await portTaken()); i++) await sleep(250);
    app.relaunch();
    app.exit(0);
  })();
  return restarting;
});

ipcMain.handle("mac-pip-open", () => {
  if (pipWin && !pipWin.isDestroyed()) return pipWin.focus();
  const area = screen.getDisplayMatching(mainWin?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }).workArea;
  pipWin = new BrowserWindow({
    width: 300,
    height: 420,
    minWidth: 220,
    minHeight: 180,
    x: area.x + area.width - 320,
    y: area.y + 60,
    frame: false,
    skipTaskbar: true,
    backgroundColor: "#F2F2F0",
    title: "Your PC",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  pipWin.setAlwaysOnTop(true, "floating");
  void pipWin.loadURL(`${URL}/pip`);
  pipWin.on("closed", () => (pipWin = undefined));
});
ipcMain.handle("mac-pip-close", () => pipWin?.close());
ipcMain.handle("mac-show-main", () => showMain());

// ---------------------------------------------------------------- New versions (desktop/win-update.cjs)

/*
 * A release build asks deskwisp.com for a newer version at launch, every hour, and when you press
 * "Check for updates" in About (components/app/about.tsx). A newer one comes down by itself (unless
 * you turned that off in About), then the sidebar's notice and About offer "Restart to update", which
 * shows the update screen (desktop/update.html) while Deskwisp saves, starts the installer and closes;
 * the installer opens the new version. Quitting installs it too. An update that didn't finish is
 * offered again at the next launch, with the installer's window this time. A build from the source
 * folder never updates: it's as new as the source.
 */
const SITE_URL = "https://deskwisp.com";
const UPDATE_PAGE = path.join(__dirname, "update.html");
/** This app's version (a build from the source folder has no installer's: package.json's). */
const VERSION = (() => {
  if (app.isPackaged) return app.getVersion();
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  } catch {
    return app.getVersion();
  }
})();
/**
 * The Microsoft Store's Deskwisp (an MSIX package: electron-builder.win.json's appx, scripts/release-store.sh).
 * It's its own app beside the one from deskwisp.com, with its own data: the Store keeps it up to date, so it
 * never downloads or runs an installer, and Windows gives it its app id from the package.
 */
const STORE = process.windowsStore === true;
/** Its page in the Store app (Partner Center's Store ID). */
const STORE_PAGE = "ms-windows-store://pdp/?ProductId=9N9QZ5QT9Q2N";
const updatesOn = () => app.isPackaged && !STORE && (userEnv().DESKWISP_UPDATES ?? process.env.DESKWISP_UPDATES) !== "0";

const settingsFile = () => path.join(app.getPath("userData"), "update-settings.json");
function autoDownload() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8")).auto !== false;
  } catch {
    return true;
  }
}
const updater = createUpdater({
  currentVersion: VERSION,
  dir: path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "deskwisp-updater"),
  logFile: path.join(app.getPath("logs"), "updates.log"),
  auto: autoDownload,
  onChange: () => tellUpdate(),
});

// While "Restart to update" runs: where it's at, for the update screen.
let installStatus;
/** Where updates are at, for About and the update screen. */
function updateStatus() {
  if (installStatus) return installStatus;
  if (!updatesOn()) return { current: VERSION, state: "off", reason: STORE ? "store" : app.isPackaged ? "turned-off" : "source" };
  return updater.status();
}

const dismissedFile = () => path.join(app.getPath("userData"), "update-dismissed.json");
function dismissedVersion() {
  try {
    return JSON.parse(fs.readFileSync(dismissedFile(), "utf8")).version;
  } catch {
    return undefined;
  }
}
/**
 * What the sidebar's notice shows: { version, notes, ready } once a newer version is here (ready) or is out
 * but didn't come down (automatic downloads off, or a download that failed), unless put away for that version.
 */
function updateInfo() {
  const s = updateStatus();
  if (!s.version || !["ready", "available", "error"].includes(s.state) || s.version === dismissedVersion()) return null;
  return { version: s.version, notes: s.notes ?? [], ready: s.state === "ready" };
}
let toldInfo = "null";
function tellUpdate() {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send("update-status", updateStatus());
  const info = JSON.stringify(updateInfo());
  if (info === toldInfo) return;
  toldInfo = info;
  mainWin.webContents.send("update", updateInfo());
}

let installing;
/**
 * Restart to update: the update screen, while the server saves and stops, then the installer takes over
 * (it waits for Deskwisp to close, installs, and opens the new version). Back to work if it won't run.
 */
function restartToUpdate() {
  if (!updater.isReady()) return Promise.resolve(false);
  installing ??= (async () => {
    const { version, notes, retry } = updater.status();
    mainLog(`Restart to update to ${version}${retry ? " (again, with the installer's window)" : ""}`);
    leaving = true;
    const step = (name, progress) => {
      installStatus = { current: VERSION, state: "installing", version, notes, step: name, progress, ...(retry ? { retry: true } : {}) };
      tellUpdate();
    };
    step("saving", 0.06);
    if (mainWin && !mainWin.isDestroyed()) await mainWin.loadFile(UPDATE_PAGE, { query: { phase: "updating", version } }).catch(() => {});
    await sleep(400);
    step("saving", 0.18);
    await stopServer();
    step("closing", 0.48);
    for (let i = 0; i < 28 && (await portTaken()); i++) await sleep(250);
    step("installing", 0.74);
    await sleep(500);
    // The installer waits a few seconds for Deskwisp to close by itself (build/installer.nsh): it does.
    if (updater.install({ reopen: true })) {
      step("opening", 1);
      await sleep(700);
      app.exit(0);
      return true;
    }
    mainLog("the installer wouldn't run: staying on this version");
    installStatus = undefined;
    installing = undefined;
    leaving = false;
    tellUpdate();
    if (mainWin && !mainWin.isDestroyed()) void openApp(mainWin, { skipUpdate: true });
    return false;
  })();
  return installing;
}

ipcMain.handle("update-info", () => updateInfo());
ipcMain.handle("update-status", () => updateStatus());
ipcMain.handle("update-check", () => (updatesOn() && !installStatus ? updater.check() : updateStatus()));
ipcMain.handle("update-get", () => {
  if (updatesOn()) void updater.download();
  return updateStatus();
});
ipcMain.handle("update-install", () => restartToUpdate());
// "Later" on the update screen shown at launch: the app, on this version (the update stays ready).
ipcMain.handle("update-later", () => mainWin && !mainWin.isDestroyed() && openApp(mainWin, { skipUpdate: true }));
ipcMain.handle("update-auto", (_, on) => {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ auto: !!on }));
  } catch {}
  if (on && updatesOn() && updater.status().state === "available") void updater.download();
  tellUpdate();
  return updateStatus();
});
ipcMain.handle("update-dismiss", (_, version) => {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) return;
  try {
    fs.writeFileSync(dismissedFile(), JSON.stringify({ version, at: Date.now() }));
  } catch {}
  tellUpdate();
});
/** The notice's button: restart into a ready update, else bring it down here, else the website. */
ipcMain.handle("update-download", () => {
  if (STORE) return shell.openExternal(STORE_PAGE);
  if (updater.isReady()) return restartToUpdate();
  if (updatesOn() && updater.status().version) return void updater.download();
  return shell.openExternal(`${SITE_URL}/download/Deskwisp-Setup.exe`);
});

// ---------------------------------------------------------------- About (components/app/about.tsx)

ipcMain.handle("app-about", () => ({
  version: VERSION,
  packaged: app.isPackaged,
  platform: "Windows",
  arch: process.arch,
  os: require("node:os").release(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// ---------------------------------------------------------------- Start and quit

app.setName("Deskwisp");
// The Store's package has its own id from Windows; setting one would part its notifications and taskbar from it.
if (!STORE) app.setAppUserModelId("app.deskwisp.windows");
const first = app.requestSingleInstanceLock();
if (!first) app.quit();
app.on("second-instance", () => app.isReady() && showMain());
app.whenReady().then(() => {
  if (!first) return;
  Menu.setApplicationMenu(null);
  mainLog(`data in ${app.getPath("userData")}, server ${packagedDir() ?? "next dev"}`);
  mainLog(`Deskwisp ${VERSION} (Windows) opening (pid ${process.pid})`);
  createWindow();
  setTimeout(() => updatesOn() && void updater.check(), 20_000);
  setInterval(() => updatesOn() && void updater.check(), 60 * 60_000).unref();
});

app.on("window-all-closed", () => app.quit());

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  // Let the server save before it goes, then quit for real.
  e.preventDefault();
  quitting = true;
  leaving = true;
  void stopServer().finally(() => app.quit());
});
// Quitting with a new version ready installs it, once Deskwisp has closed (it isn't opened again).
app.on("quit", () => {
  if (updatesOn() && updater.isReady()) updater.install({ reopen: false });
});
