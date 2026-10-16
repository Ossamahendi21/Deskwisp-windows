import { readFileSync } from "node:fs";

/**
 * The page the app opens in the browser to sign in (/cli/approve?code=XXXX-XXXX): Clerk's sign-in
 * (Google or email) if the browser isn't signed in yet, then "Sign in to Deskwisp on <this PC>?" with
 * the code to compare against the app's, and Allow / Don't allow. Clerk's script comes from the
 * instance's own Frontend API host, which the publishable key names. It's clerk-js 5: 6 no longer
 * carries the sign-in components (they come from @clerk/ui, passed to Clerk.load), so with it
 * mountSignIn draws nothing.
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
      ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${opts.publishableKey.replace(/"/g, "")}" src="https://${opts.frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
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
  <div id="clerk-captcha"></div>
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
  var redirecting = false;
  async function render() {
    var Clerk = window.Clerk;
    if (redirecting) return;
    if (!Clerk.user) {
      // Continue with Google in the app: straight to Google, once (if it comes back without a user,
      // Clerk's own form is the way on). The SSO callback page brings the browser back here.
      var tried = "dw-google-" + code;
      var wantsGoogle = new URLSearchParams(location.search).get("provider") === "google";
      var triedGoogle = false;
      try { triedGoogle = sessionStorage.getItem(tried) === "1"; sessionStorage.setItem(tried, "1"); } catch (e) {}
      if (wantsGoogle && !triedGoogle) {
        redirecting = true;
        show("Opening Google…", "");
        await Clerk.client.signIn.authenticateWithRedirect({
          strategy: "oauth_google",
          redirectUrl: location.origin + "/cli/sso-callback?next=" + encodeURIComponent(location.pathname + location.search),
          redirectUrlComplete: location.href
        });
        return;
      }
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
    // Anything that goes wrong is said on the page, never a blank one.
    var safe = function () { render().catch(function (e) { show("Couldn't show sign-in", String(e && e.message || e), { bad: true }); }); };
    window.Clerk.addListener(safe);
    safe();
  });
})();
</script>
</body>
</html>`;
}

/**
 * Where Google sends the browser back to (through Clerk): Clerk finishes the sign-in, or makes the
 * account for a new Google user, then the browser goes on to `next`, the approve page it came from.
 */
export function ssoCallbackPage(opts: { publishableKey: string | null; frontendApi: string | null }) {
  const clerkScript =
    opts.publishableKey && opts.frontendApi
      ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${opts.publishableKey.replace(/"/g, "")}" src="https://${opts.frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in to Deskwisp</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px;
         font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #16132B; background: #F3F0FF; }
  .logo svg { width: 48px; height: 48px; display: block; }
  p { margin: 0; color: #6B6880; max-width: 420px; text-align: center; }
  #more { color: #16132B; font-weight: 600; }
</style>
</head>
<body>
<div class="logo" aria-hidden="true">${LOGO}</div>
<p id="line">Signing you in…</p>
<a id="more" hidden>Continue</a>
<div id="clerk-captcha"></div>
${clerkScript}
<script>
window.addEventListener("load", async function () {
  var line = document.getElementById("line");
  var more = document.getElementById("more");
  // Only back to this server's own approve page.
  var next = new URLSearchParams(location.search).get("next") || "";
  // (No regular expression here: inside this template string its backslashes would be eaten.)
  if (next.indexOf("/cli/approve?") !== 0) next = "/cli/approve";
  more.href = next;
  var gone = false;
  var go = function () { if (!gone) { gone = true; location.replace(next); } };
  var say = function (text) { line.textContent = text; more.hidden = false; };
  window.addEventListener("unhandledrejection", function (e) { say("That didn't work: " + (e.reason && e.reason.message || e.reason)); });
  if (!window.Clerk) return say("Couldn't load sign-in. Check your connection, then try again from the app.");
  // However Clerk finishes (it may not move on by itself), the browser goes on once someone is signed in,
  // and a way on shows if it takes too long.
  var watch = setInterval(function () { if (window.Clerk.user) { clearInterval(watch); go(); } }, 400);
  setTimeout(function () { if (!gone) say("This is taking longer than it should."); }, 10000);
  try {
    await window.Clerk.load();
    if (window.Clerk.user) return go();
    await window.Clerk.handleRedirectCallback({
      signInForceRedirectUrl: next,
      signUpForceRedirectUrl: next,
      signInFallbackRedirectUrl: next,
      signUpFallbackRedirectUrl: next,
      continueSignUpUrl: next,
      firstFactorUrl: next,
      secondFactorUrl: next
    });
    setTimeout(function () { if (window.Clerk.user) go(); }, 300);
  } catch (e) {
    say("That didn't work: " + (e && (e.errors && e.errors[0] && (e.errors[0].longMessage || e.errors[0].message)) || e.message || e));
  }
});
</script>
</body>
</html>`;
}
