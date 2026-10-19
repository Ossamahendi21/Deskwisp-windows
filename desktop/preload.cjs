/** What the Deskwisp page may ask the PC app for: its screens and windows, to show them live, its permissions, and whether a newer version is out. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskwispMac", {
  screens: () => ipcRenderer.invoke("mac-screens"),
  openScreenSettings: () => ipcRenderer.invoke("mac-screen-settings"),
  // The PC previews in a small window of their own that floats over every app.
  popOut: () => ipcRenderer.invoke("mac-pip-open"),
  closePip: () => ipcRenderer.invoke("mac-pip-close"),
  showMain: () => ipcRenderer.invoke("mac-show-main"),
  // What Deskwisp may use on this PC (screen, microphone, notifications), asked for in one place.
  permissions: {
    status: () => ipcRenderer.invoke("perm-status"),
    request: (id) => ipcRenderer.invoke("perm-request", id),
    openSettings: (id) => ipcRenderer.invoke("perm-settings", id),
    // Full access's apps, each with its Automation answer (null until Deskwisp can read them).
    automationApps: () => ipcRenderer.invoke("perm-automation-apps"),
  },
  // Screen Recording turned on since launch only works after a restart.
  screenNeedsRestart: () => ipcRenderer.invoke("perm-screen-restart"),
  // Restart Deskwisp, cleanly: the state saved, cached sessions dropped, the server started
  // again, and the app opened again. Still signed in, nothing lost (desktop/main.cjs).
  relaunch: () => ipcRenderer.invoke("relaunch"),
  // The page shown when Deskwisp can't start (desktop/trouble.html): start again, or open the logs folder.
  startup: {
    retry: () => ipcRenderer.invoke("startup-retry"),
    logs: () => ipcRenderer.invoke("startup-logs"),
  },
  // A newer release on deskwisp.com ({ version, notes, ready } or null), as it changes. On Windows it comes
  // down by itself and `ready` says it's here: then download() restarts into it (desktop/win-update.cjs).
  // The Mac app doesn't update itself: download() opens deskwisp.com.
  update: {
    info: () => ipcRenderer.invoke("update-info"),
    onChange: (fn) => {
      const on = (_, info) => fn(info);
      ipcRenderer.on("update", on);
      return () => ipcRenderer.off("update", on);
    },
    dismiss: (version) => ipcRenderer.invoke("update-dismiss", version),
    download: () => ipcRenderer.invoke("update-download"),
    // About and the update screen (desktop/update.html): where updates are at ({ current, state, version,
    // notes, progress, … }, desktop/win-update.cjs), as it changes; check now; bring a newer one down;
    // restart into it; "Later" on the update screen; whether newer versions come down by themselves.
    status: () => ipcRenderer.invoke("update-status"),
    onStatus: (fn) => {
      const on = (_, status) => fn(status);
      ipcRenderer.on("update-status", on);
      return () => ipcRenderer.off("update-status", on);
    },
    check: () => ipcRenderer.invoke("update-check"),
    get: () => ipcRenderer.invoke("update-get"),
    install: () => ipcRenderer.invoke("update-install"),
    later: () => ipcRenderer.invoke("update-later"),
    setAuto: (on) => ipcRenderer.invoke("update-auto", !!on),
  },
  // About Deskwisp: this app's version, what it runs on, and the licence and credits that ship with it.
  about: () => ipcRenderer.invoke("app-about"),
});
