import { readFileSync } from "node:fs";

/**
 * The page the app opens in the browser to sign in (/cli/approve?code=XXXX-XXXX): Clerk's sign-in
 * (Google or email) if the browser isn't signed in yet, then "Sign in to Deskwisp on <this PC>?" with
 * the code to compare against the app's, and Allow / Don't allow. Clerk's script comes from the
 * instance's own Frontend API host, which the publishable key names.
 */

const LOGO = (() => {
  try {
    return readFileSync(new URL("../../assets/icon.svg", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();

/** For a value put inside <script type="application/json">: nothing in it can close the tag. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function approvePage(opts: { publishableKey: string | null; frontendApi: string | null }) {
  const clerkScript =
    opts.publishableKey && opts.frontendApi
      ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${opts.publishableKey.replace(/"/g, "")}" src="https://${opts.frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Deskwisp</title>
<style>
  :root { --ink: #16132B; --pencil: #6B6880; --line: #E4E0F2; --accent: #7C5CFF; --wash: #F3F0FF; --card: #FFFFFF; --bad: #B42318; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
         font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
         background: radial-gradient(1200px 600px at 50% -10%, #E6DFFF 0%, var(--wash) 45%, #FBFAFF 100%); }
  main { width: 100%; max-width: 400px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .logo svg { width: 48px; height: 48px; display: block; }
  .card { width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px;
          box-shadow: 0 12px 40px -18px rgba(22, 19, 43, .35); text-align: center; }
  h1 { font-size: 19px; line-height: 24px; margin: 0 0 6px; letter-spacing: -.01em; }
  p { margin: 0; color: var(--pencil); }
  .code { margin: 18px 0; font: 600 26px/1 ui-monospace, "SF Mono", Consolas, monospace; letter-spacing: .12em;
          background: var(--wash); border-radius: 12px; padding: 14px 0; }
  .row { display: flex; gap: 8px; margin-top: 4px; }
  button { flex: 1; height: 40px; border-radius: 10px; font: 600 14px/1 inherit; cursor: pointer; border: 1px solid var(--line); background: #fff; color: var(--ink); }
  button.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .small { font-size: 12.5px; margin-top: 14px; }
  .small a { color: var(--pencil); }
  .bad { color: var(--bad); }
  #sign-in { display: flex; justify-content: center; width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true">${LOGO}</div>
  <div id="sign-in" hidden></div>
  <div class="card" id="card">
    <h1 id="title">Loading…</h1>
    <p id="line"></p>
    <div class="code" id="code" hidden></div>
    <div class="row" id="actions" hidden>
      <button id="deny" type="button">Don't allow</button>
      <button id="allow" class="primary" type="button">Allow</button>
    </div>
    <p class="small" id="who" hidden></p>
  </div>
</main>
<script type="application/json" id="cfg">${scriptJson({ ready: !!(opts.publishableKey && opts.frontendApi) })}</script>
${clerkScript}
<script>
(function () {
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var code = (new URLSearchParams(location.search).get("code") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9);
  var $ = function (id) { return document.getElementById(id); };
  function show(title, line, opts) {
    opts = opts || {};
    $("card").hidden = false;
    $("title").textContent = title;
    $("line").textContent = line || "";
    $("line").className = opts.bad ? "bad" : "";
    $("code").hidden = !opts.code;
    if (opts.code) $("code").textContent = code;
    $("actions").hidden = !opts.actions;
  }
  if (!cfg.ready) return show("Sign-in isn't set up", "This server has no Clerk publishable key (CLERK_PUBLISHABLE_KEY).", { bad: true });
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return show("No code here", "Start signing in from the Deskwisp app: it opens this page with its code.", { bad: true });

  var mounted = false;
  async function render() {
    var Clerk = window.Clerk;
    if (!Clerk.user) {
      $("card").hidden = true;
      $("sign-in").hidden = false;
      if (!mounted) {
        mounted = true;
        Clerk.mountSignIn($("sign-in"), {
          forceRedirectUrl: location.href,
          signUpForceRedirectUrl: location.href,
          appearance: { variables: { colorPrimary: "#16132B", borderRadius: "10px" } }
        });
      }
      return;
    }
    if (mounted) { Clerk.unmountSignIn($("sign-in")); mounted = false; }
    $("sign-in").hidden = true;
    var who = Clerk.user.primaryEmailAddress ? Clerk.user.primaryEmailAddress.emailAddress : "";
    $("who").hidden = false;
    $("who").innerHTML = "";
    $("who").append("Signed in as " + who + ". ");
    var out = document.createElement("a");
    out.href = "#"; out.textContent = "Not you?";
    out.onclick = function (e) { e.preventDefault(); Clerk.signOut({ redirectUrl: location.href }); };
    $("who").append(out);

    var info = await fetch("/api/cli/auth/info?code=" + encodeURIComponent(code)).then(function (r) { return r.json(); }).catch(function () { return null; });
    if (!info) return show("Couldn't reach Deskwisp", "Check your connection, then reload this page.", { bad: true });
    if (info.state === "unknown" || info.state === "expired") return show("This code expired", "Go back to the Deskwisp app and get a new one.", { bad: true });
    if (info.state === "approved") return show("You're signed in", "Go back to the Deskwisp app. You can close this tab.");
    if (info.state === "denied") return show("Not allowed", "This PC wasn't signed in. Start again from the app if that was a mistake.");
    show("Sign in to Deskwisp" + (info.hostname ? " on " + info.hostname : "") + "?", "Check that the app shows the same code.", { code: true, actions: true });
  }

  async function decide(approve) {
    $("allow").disabled = $("deny").disabled = true;
    try {
      var token = await window.Clerk.session.getToken();
      var res = await fetch("/api/cli/auth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ user_code: code, approve: approve })
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) return show("That didn't work", body.error || ("Error " + res.status), { bad: true });
      if (approve) show("You're signed in", "Go back to the Deskwisp app. You can close this tab.");
      else show("Not allowed", "This PC wasn't signed in.");
    } catch (e) {
      show("That didn't work", "Check your connection and try again.", { bad: true, code: true, actions: true });
    } finally {
      $("allow").disabled = $("deny").disabled = false;
    }
  }
  $("allow").onclick = function () { decide(true); };
  $("deny").onclick = function () { decide(false); };

  window.addEventListener("load", async function () {
    if (!window.Clerk) return show("Couldn't load sign-in", "Check your connection, or turn off a blocker for this page, then reload.", { bad: true });
    try {
      await window.Clerk.load();
    } catch (e) {
      return show("Couldn't load sign-in", String(e && e.message || e), { bad: true });
    }
    window.Clerk.addListener(function () { render(); });
    render();
  });
})();
</script>
</body>
</html>`;
}
