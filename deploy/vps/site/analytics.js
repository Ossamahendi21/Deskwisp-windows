// deskwisp.com's visitor counts: Google Analytics 4, asked for first. Until a visitor says yes, Google
// gets only cookieless pings (Consent Mode: no cookies, no identifiers); after a yes, full analytics.
// The choice is kept in this browser and can be changed from "Cookie settings" in the footer.
// Every click on the Windows download counts as a "download_windows" event, with the spot it came from.
(() => {
  // The site's GA4 Measurement ID (Google Analytics → Admin → Data streams → the web stream).
  const GA_ID = "G-HW0D4E140P";
  if (!/^G-[A-Z0-9]{6,}$/.test(GA_ID)) return;

  const KEY = "deskwisp-consent";
  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const keep = (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {}
  };

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    dataLayer.push(arguments);
  }
  window.gtag = gtag;
  const choice = read();
  const granted = choice === "yes" ? "granted" : "denied";
  gtag("consent", "default", { analytics_storage: granted, ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  gtag("js", new Date());
  gtag("config", GA_ID);
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);

  // Downloads: any link to the installer, wherever it is on the page.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href$="Deskwisp-Setup.exe"]');
    if (!a) return;
    const where = a.closest("section")?.id || (a.closest("header") ? "header" : "page");
    gtag("event", "download_windows", { link_location: where, page_path: location.pathname, transport_type: "beacon" });
  });

  // The question, at the bottom of the screen, until it's answered.
  const css = `
.consent{position:fixed;z-index:50;left:16px;right:16px;bottom:16px;margin:0 auto;max-width:560px;display:flex;align-items:center;gap:16px;
padding:16px 18px;border-radius:16px;background:#fff;color:#16132b;font:15px/1.45 Geist,"Segoe UI",system-ui,sans-serif;
box-shadow:0 0 0 1px rgba(22,19,43,.1),0 20px 40px -20px rgba(22,19,43,.45)}
.consent p{margin:0;flex:1}.consent a{color:inherit}
.consent .b{display:flex;gap:8px;flex:none}
.consent button{font:600 14px/1 Geist,"Segoe UI",system-ui,sans-serif;padding:10px 16px;border-radius:999px;border:0;cursor:pointer;background:#f0f0ee;color:#16132b}
.consent button.y{background:#16132b;color:#fff}
@media (max-width:560px){.consent{flex-direction:column;align-items:stretch}.consent .b button{flex:1}}`;
  function ask() {
    if (document.querySelector(".consent")) return;
    if (!document.getElementById("consent-css")) {
      const st = document.createElement("style");
      st.id = "consent-css";
      st.textContent = css;
      document.head.appendChild(st);
    }
    const box = document.createElement("div");
    box.className = "consent";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Cookies");
    box.innerHTML = `<p>We use Google Analytics cookies to see how people find and use this site. <a href="/privacy/#website">More</a></p><div class="b"><button type="button" class="n">No thanks</button><button type="button" class="y">Accept</button></div>`;
    const answer = (yes) => {
      keep(yes ? "yes" : "no");
      gtag("consent", "update", { analytics_storage: yes ? "granted" : "denied" });
      box.remove();
    };
    box.querySelector(".y").addEventListener("click", () => answer(true));
    box.querySelector(".n").addEventListener("click", () => answer(false));
    document.body.appendChild(box);
  }
  const start = () => {
    if (!choice) ask();
    const foot = document.querySelector(".foot .wrap");
    if (foot && !foot.querySelector(".consent-link")) {
      const b = document.createElement("a");
      b.href = "#";
      b.className = "consent-link";
      b.textContent = "Cookie settings";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        ask();
      });
      foot.appendChild(b);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
