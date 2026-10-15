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

const PORT = Number(process.env.DESKWISP_PORT) || 3210;
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
  fs.writeSync(log, `\n--- Deskwisp ${app.getVersion()} (Windows) starting, ${new Date().toISOString()}\n`);
  const common = {
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
    if (who.up) return { ok: false, reason: "port-taken", detail: `another program answers on port ${PORT}` };
    if (!(await portTaken()) && !server) {
      if (spawned >= 2) return { ok: false, reason: "server-ended", detail: serverEnded };
      spawned++;
      mainLog(spawned === 1 ? "starting the server" : `starting the server again (it ${serverEnded ?? "stopped"})`);
      spawnServer();
    }
    // `next dev` compiles on its first request: give it longer.
    if (Date.now() - started > (packagedDir() ? 90_000 : 240_000)) return { ok: false, reason: "server-slow", detail: serverEnded };
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
function openApp(win) {
  opening ??= (async () => {
    try {
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", (_, d) => {
    if (leaving || d.reason === "clean-exit" || d.reason === "launch-failed") return;
    mainLog(`the window's page crashed: ${d.reason}`);
    setTimeout(() => void openApp(win), 1000);
  });
  void openApp(win);
}

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

// No updates from deskwisp.bot: those are the PC app's. This build updates when you build it again.
ipcMain.handle("update-info", () => null);
ipcMain.handle("update-dismiss", () => undefined);
ipcMain.handle("update-download", () => undefined);

// ---------------------------------------------------------------- Start and quit

app.setName("Deskwisp");
app.setAppUserModelId("app.deskwisp.windows");
const first = app.requestSingleInstanceLock();
if (!first) app.quit();
app.on("second-instance", () => app.isReady() && showMain());
app.whenReady().then(() => {
  if (!first) return;
  Menu.setApplicationMenu(null);
  mainLog(`data in ${app.getPath("userData")}, server ${packagedDir() ?? "next dev"}`);
  mainLog(`Deskwisp ${app.getVersion()} (Windows) opening (pid ${process.pid})`);
  createWindow();
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
