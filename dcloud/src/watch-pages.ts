import { LOGO, scriptJson } from "./pages.ts";

/**
 * The pages for people in their browser (people.ts): accepting an invite (/accept-invite?token=…),
 * and watching the bots' computers live (/watch), the user's own and the ones shared with them, on a
 * phone too. Both sign in with Clerk the way the approve page does (clerk-js 5 from the instance's
 * Frontend API). The live view is the app's own noVNC, served by this server (/novnc/…).
 *
 * Inside these template strings, the pages' scripts use no backslashes and no "${": both would be
 * read by TypeScript, not the browser (accounts.test.ts parses every page's scripts).
 */

type Opts = { publishableKey: string | null; frontendApi: string | null };

const clerkScript = (o: Opts) =>
  o.publishableKey && o.frontendApi
    ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${o.publishableKey.replace(/"/g, "")}" src="https://${o.frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
    : "";

const STYLE = `
  :root { --ink: #16132B; --pencil: #6B6880; --line: #E4E0F2; --accent: #7C5CFF; --wash: #F3F0FF; --card: #FFFFFF; --bad: #B42318; --good: #067647; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
         background: radial-gradient(1200px 600px at 50% -10%, #E6DFFF 0%, var(--wash) 45%, #FBFAFF 100%); }
  .logo svg { width: 40px; height: 40px; display: block; }
  .card { width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px;
          box-shadow: 0 12px 40px -18px rgba(22, 19, 43, .35); }
  h1 { font-size: 19px; line-height: 24px; margin: 0 0 6px; letter-spacing: -.01em; }
  p { margin: 0; color: var(--pencil); }
  button, .button { height: 38px; padding: 0 16px; border-radius: 10px; font: 600 14px/1 inherit; cursor: pointer; border: 1px solid var(--line);
           background: #fff; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  button.primary, .button.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .bad { color: var(--bad); }
  .small { font-size: 12.5px; }
  .small a { color: var(--pencil); }
  #sign-in { display: flex; justify-content: center; width: 100%; }
  [hidden] { display: none !important; }
`;

/** Clerk loaded and listened to; `render` runs whenever who's signed in changes. Shared by both pages. */
const CLERK_BOOT = `
  function whenLoaded(fn) { if (document.readyState === "complete") fn(); else window.addEventListener("load", fn); }
  function bootClerk(onError, render) {
    whenLoaded(async function () {
      if (!window.Clerk) return onError("Couldn't load sign-in. Check your connection, or turn off a blocker for this page, then reload.");
      try { await window.Clerk.load(); } catch (e) { return onError(String(e && e.message || e)); }
      var safe = function () { Promise.resolve().then(render).catch(function (e) { onError(String(e && e.message || e)); }); };
      window.Clerk.addListener(safe);
      safe();
    });
  }
  var mounted = false;
  function showSignIn(box, back) {
    box.hidden = false;
    if (mounted) return;
    mounted = true;
    window.Clerk.mountSignIn(box, {
      forceRedirectUrl: back, signUpForceRedirectUrl: back,
      appearance: { variables: { colorPrimary: "#16132B", borderRadius: "10px" } }
    });
  }
  function hideSignIn(box) {
    if (mounted) { window.Clerk.unmountSignIn(box); mounted = false; }
    box.hidden = true;
  }
  async function api(path, opts) {
    opts = opts || {};
    var token = await window.Clerk.session.getToken();
    var res = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ Authorization: "Bearer " + token }, opts.body ? { "Content-Type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { var e = new Error(body.error || ("Error " + res.status)); e.status = res.status; throw e; }
    return body;
  }
`;

export function acceptPage(o: Opts) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join on Deskwisp</title>
<style>${STYLE}
  body { display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 400px; display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
  .row { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true">${LOGO}</div>
  <div id="sign-in" hidden></div>
  <div id="clerk-captcha"></div>
  <div class="card" id="card">
    <h1 id="title">Loading…</h1>
    <p id="line"></p>
    <div class="row" id="go" hidden><a class="button primary" href="/watch">Watch the bots</a></div>
    <p class="small" id="who" hidden style="margin-top:14px"></p>
  </div>
</main>
<script type="application/json" id="cfg">${scriptJson({ ready: !!(o.publishableKey && o.frontendApi) })}</script>
${clerkScript(o)}
<script>
(function () {
  ${CLERK_BOOT}
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var token = new URLSearchParams(location.search).get("token") || "";
  var $ = function (id) { return document.getElementById(id); };
  function show(title, line, opts) {
    opts = opts || {};
    $("card").hidden = false;
    $("title").textContent = title;
    $("line").textContent = line || "";
    $("line").className = opts.bad ? "bad" : "";
    $("go").hidden = !opts.go;
  }
  if (!cfg.ready) return show("Sign-in isn't set up", "This server has no Clerk publishable key (CLERK_PUBLISHABLE_KEY).", { bad: true });
  if (!token) return show("No invite here", "Open the link from your invite.", { bad: true });
  var tried = false;
  bootClerk(function (m) { show("Couldn't sign in", m, { bad: true }); }, async function () {
    var Clerk = window.Clerk;
    if (!Clerk.user) {
      $("card").hidden = true;
      return showSignIn($("sign-in"), location.href);
    }
    hideSignIn($("sign-in"));
    var who = Clerk.user.primaryEmailAddress ? Clerk.user.primaryEmailAddress.emailAddress : "";
    $("who").hidden = false;
    $("who").textContent = "Signed in as " + who + ". ";
    var out = document.createElement("a");
    out.href = "#"; out.textContent = "Use another email";
    out.onclick = function (e) { e.preventDefault(); Clerk.signOut({ redirectUrl: location.href }); };
    $("who").append(out);
    if (tried) return;
    tried = true;
    show("Joining…", "");
    try {
      var r = await api("/api/invites/accept", { method: "POST", body: { token: token } });
      show("You're in", r.owner + " shared their bots' computers with you" + (r.role === "admin" ? ": you can use them." : ": you can watch them live."), { go: true });
    } catch (e) {
      show("Couldn't join", e.message, { bad: true });
    }
  });
})();
</script>
</body>
</html>`;
}

export function watchPage(o: Opts) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch your bots · Deskwisp</title>
<style>${STYLE}
  header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; max-width: 1100px; margin: 0 auto; }
  header .name { font-weight: 700; font-size: 16px; flex: 1; }
  header .who { font-size: 12.5px; color: var(--pencil); text-align: right; }
  header .who a { color: var(--pencil); }
  main { max-width: 1100px; margin: 0 auto; padding: 0 16px 32px; display: flex; flex-direction: column; gap: 14px; }
  .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .pc { display: flex; flex-direction: column; gap: 10px; }
  .pc .top { display: flex; align-items: center; gap: 8px; }
  .pc .title { font-weight: 650; font-size: 15px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 99px; background: var(--wash); color: var(--pencil); white-space: nowrap; }
  .chip.on { background: #ECFDF3; color: var(--good); }
  .viewer { display: flex; flex-direction: column; gap: 10px; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .bar .grow { flex: 1; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .tabs button { height: 32px; padding: 0 12px; font-size: 13px; }
  .tabs button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  /* The whole screen in view: as wide as there's room for, never taller than the window leaves. */
  #screen { width: min(100%, calc((100vh - 230px) * 4 / 3)); min-width: min(100%, 320px); margin: 0 auto; aspect-ratio: 4 / 3; background: #0E0C1A;
            border-radius: 14px; overflow: hidden; position: relative; }
  #screen > div { width: 100% !important; height: 100% !important; }
  #status { font-size: 12.5px; color: var(--pencil); }
  .empty { text-align: center; padding: 28px 16px; }
  #sign-in-wrap { display: flex; justify-content: center; padding-top: 24px; }
</style>
</head>
<body>
<header>
  <div class="logo" aria-hidden="true">${LOGO}</div>
  <div class="name">Deskwisp</div>
  <div class="who" id="who" hidden></div>
</header>
<main>
  <div id="sign-in-wrap"><div id="sign-in" hidden></div></div>
  <div id="clerk-captcha"></div>
  <div class="card empty" id="note"><h1 id="title">Loading…</h1><p id="line"></p></div>

  <section id="pick" hidden>
    <p style="margin:2px 2px 10px">Your bots' computers, and the ones people shared with you. Open one to watch it live.</p>
    <div class="list" id="list"></div>
  </section>

  <section class="viewer" id="viewer" hidden>
    <div class="bar">
      <button id="back" type="button">← All computers</button>
      <strong id="pcname" class="grow"></strong>
      <span class="chip" id="mode"></span>
      <button id="control" type="button" hidden>Take control</button>
    </div>
    <div class="tabs" id="tabs"></div>
    <div id="screen"></div>
    <div class="bar"><span id="status" class="grow"></span><button id="again" type="button" hidden>Reconnect</button></div>
  </section>
</main>
<script type="application/json" id="cfg">${scriptJson({ ready: !!(o.publishableKey && o.frontendApi) })}</script>
${clerkScript(o)}
<script type="module">
import RFB from "/novnc/core/rfb.js";
${CLERK_BOOT}
var cfg = JSON.parse(document.getElementById("cfg").textContent);
var $ = function (id) { return document.getElementById(id); };
function note(title, line, bad) {
  $("note").hidden = false;
  $("title").textContent = title;
  $("line").textContent = line || "";
  $("line").className = bad ? "bad" : "";
}
var ROLE = { owner: "Yours", admin: "Full access", member: "View only" };
var rfb = null, open = null, screenId = "default", control = false;

function stop() {
  if (rfb) { try { rfb.disconnect(); } catch (e) {} rfb = null; }
  $("screen").innerHTML = "";
}

async function list() {
  stop();
  $("viewer").hidden = true;
  var r;
  try { r = await api("/api/watch"); } catch (e) { return note("Couldn't load your computers", e.message, true); }
  var box = $("list");
  box.innerHTML = "";
  if (!r.computers.length) {
    $("pick").hidden = true;
    return note("Nothing to watch yet", "Your bots' computers show here once Deskwisp has set one up, and so do the ones people share with you.");
  }
  $("note").hidden = true;
  $("pick").hidden = false;
  r.computers.forEach(function (c) {
    var card = document.createElement("div");
    card.className = "card pc";
    var top = document.createElement("div");
    top.className = "top";
    var t = document.createElement("span");
    t.className = "title";
    t.textContent = c.owner === "You" ? c.name : c.owner + " · " + c.name;
    var chip = document.createElement("span");
    chip.className = "chip" + (c.asleep ? "" : " on");
    chip.textContent = c.asleep ? "Asleep" : "Awake";
    top.append(t, chip);
    var role = document.createElement("p");
    role.className = "small";
    role.textContent = ROLE[c.role] + (c.asleep ? " · opening it wakes it up" : "");
    var go = document.createElement("button");
    go.className = "primary";
    go.type = "button";
    go.textContent = "Watch";
    go.onclick = function () { watch(c); };
    card.append(top, role, go);
    box.append(card);
  });
}

async function watch(c) {
  $("pick").hidden = true;
  $("note").hidden = true;
  $("viewer").hidden = false;
  $("pcname").textContent = c.owner === "You" ? c.name : c.owner + " · " + c.name;
  $("mode").textContent = ROLE[c.role];
  $("control").hidden = c.role === "member";
  control = false;
  $("control").textContent = "Take control";
  $("status").textContent = c.asleep ? "Waking it up…" : "Connecting…";
  $("tabs").innerHTML = "";
  stop();
  try {
    open = Object.assign({ computer: c }, await api("/api/watch/open", { method: "POST", body: { computerId: c.id } }));
  } catch (e) {
    return failed(e);
  }
  if (!open.screens.some(function (s) { return s.id === screenId; })) screenId = open.screens.length ? open.screens[0].id : "default";
  tabs();
  connect();
}

/** Opening didn't work: gone for good (their access was taken away), or worth another try. */
function failed(e) {
  stop();
  var gone = e.status === 404 || e.status === 403;
  $("status").textContent = gone ? "You don't have access to this computer any more." : "Couldn't open it: " + e.message;
  $("again").hidden = gone;
}

function tabs() {
  var box = $("tabs");
  box.innerHTML = "";
  if (open.screens.length < 2) return;
  open.screens.forEach(function (s) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Screen " + s.number;
    b.className = s.id === screenId ? "on" : "";
    b.onclick = function () { screenId = s.id; tabs(); reopen(); };
    box.append(b);
  });
}

/** A new ticket (they last two minutes), then the screen asked for. */
async function reopen() {
  var c = open.computer;
  try {
    open = Object.assign({ computer: c }, await api("/api/watch/open", { method: "POST", body: { computerId: c.id } }));
  } catch (e) {
    return failed(e);
  }
  connect();
}

function connect() {
  stop();
  $("again").hidden = true;
  $("status").textContent = "Connecting…";
  var scheme = location.protocol === "https:" ? "wss://" : "ws://";
  var url = scheme + location.host + "/desktops/" + encodeURIComponent(open.computer.id) + "/ws/websockify?ticket=" +
    encodeURIComponent(open.ticket) + "&screen=" + encodeURIComponent(screenId);
  rfb = new RFB($("screen"), url, { credentials: { password: open.password }, wsProtocols: ["binary"] });
  rfb.viewOnly = open.viewOnly || !control;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", function () {
    $("status").textContent = open.viewOnly ? "Live. You can watch, not click or type." : control ? "Live. You're in control: clicks and keys go to the computer." : "Live. Take control to click and type.";
  });
  rfb.addEventListener("disconnect", function (e) {
    rfb = null;
    $("status").textContent = e.detail && e.detail.clean ? "Disconnected." : "The connection dropped.";
    $("again").hidden = false;
  });
  rfb.addEventListener("credentialsrequired", function () { $("status").textContent = "The password changed. Reconnect."; $("again").hidden = false; });
  rfb.addEventListener("securityfailure", function () { $("status").textContent = "Not allowed any more. Go back to the list."; });
}

$("back").onclick = function () { list(); };
$("again").onclick = function () { reopen(); };
$("control").onclick = function () {
  control = !control;
  $("control").textContent = control ? "Stop control" : "Take control";
  if (rfb) rfb.viewOnly = !control;
  if (rfb) $("status").textContent = control ? "Live. You're in control: clicks and keys go to the computer." : "Live. Take control to click and type.";
};

if (!cfg.ready) note("Sign-in isn't set up", "This server has no Clerk publishable key (CLERK_PUBLISHABLE_KEY).", true);
else {
  var shown = null;
  bootClerk(function (m) { note("Couldn't sign in", m, true); }, async function () {
    var Clerk = window.Clerk;
    if (!Clerk.user) {
      $("note").hidden = true;
      $("pick").hidden = true;
      $("viewer").hidden = true;
      $("who").hidden = true;
      stop();
      shown = null;
      return showSignIn($("sign-in"), location.href);
    }
    hideSignIn($("sign-in"));
    if (shown === Clerk.user.id) return;
    shown = Clerk.user.id;
    var who = Clerk.user.primaryEmailAddress ? Clerk.user.primaryEmailAddress.emailAddress : "";
    $("who").hidden = false;
    $("who").textContent = who + " · ";
    var out = document.createElement("a");
    out.href = "#"; out.textContent = "Sign out";
    out.onclick = function (e) { e.preventDefault(); stop(); Clerk.signOut({ redirectUrl: location.href }); };
    $("who").append(out);
    note("Loading…", "");
    await list();
  });
}
</script>
</body>
</html>`;
}
