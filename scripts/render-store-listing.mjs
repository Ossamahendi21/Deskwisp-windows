#!/usr/bin/env node
/**
 * Renders the Microsoft Store listing's pictures (docs/store/), which Partner Center takes apart from
 * the package (Store listing → Store logos, Windows and Xbox image): from the logo in lib/mascot.ts, the
 * brand font (Geist) and the app's own screenshot (docs/images/app.png). Run after changing the logo or
 * that screenshot. Needs a Chromium: Playwright's, or CHROME=<path>.
 *
 *   poster-art-1440x2160.png      9:16 Poster art: the main logo on Windows 10 and 11
 *   box-art-2160x2160.png         1:1 Box art
 *   tile-icon-{300,150,71}.png    the Store display images
 *   super-hero-art-3840x2160.png  16:9 Super hero art, at the top of the listing (no title: the Store adds it)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { ACCENT, logoMarkup } from "../lib/mascot.ts";

const root = new URL("..", import.meta.url).pathname;
const font = readFileSync(`${root}node_modules/geist/dist/fonts/geist-sans/Geist-Bold.woff2`).toString("base64");
const fontMedium = readFileSync(`${root}node_modules/geist/dist/fonts/geist-sans/Geist-Medium.woff2`).toString("base64");
const shot = readFileSync(`${root}docs/images/app.png`).toString("base64");

// Wispy alone (white, smiling, its yellow spark), in a 0 0 40 40 box: the logo without its violet.
const glyph = logoMarkup("square").replace(/^<rect[^>]*\/>/, "");
const wispy = (px) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="7.2 7.2 25.6 25.6" width="${px}" height="${px}">${glyph}</svg>`;

const DEEP = "#5638E0";
const page = (w, h, body) => `<!doctype html><html><head><style>
  @font-face { font-family: Geist; font-weight: 700; src: url(data:font/woff2;base64,${font}) format("woff2"); }
  @font-face { font-family: Geist; font-weight: 500; src: url(data:font/woff2;base64,${fontMedium}) format("woff2"); }
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
  body { position: relative; font-family: Geist, sans-serif; color: #fff;
    background: radial-gradient(120% 90% at 30% 20%, #9B82FF 0%, ${ACCENT} 45%, ${DEEP} 100%); }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .spark { position: absolute; }
</style></head><body>${body}</body></html>`;

/** Little four-point sparks scattered around, as on the update screen. */
const spark = (x, y, s, color, opacity = 1) =>
  `<svg class="spark" style="left:${x}px;top:${y}px;opacity:${opacity}" width="${s}" height="${s}" viewBox="0 0 10 10"><path d="M5 0c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z" fill="${color}"/></svg>`;
const sparks = (w, h, k) =>
  [
    [0.12, 0.1, 46, "#FFC83D"],
    [0.82, 0.14, 34, "#fff", 0.8],
    [0.9, 0.42, 26, "#7FE3D6"],
    [0.08, 0.55, 30, "#fff", 0.7],
    [0.18, 0.86, 38, "#FF9EC4"],
    [0.86, 0.84, 44, "#FFC83D", 0.9],
  ]
    .map(([x, y, s, c, o]) => spark(x * w, y * h, s * k, c, o))
    .join("");

const art = {
  "poster-art-1440x2160": [
    1440,
    2160,
    `${sparks(1440, 2160, 1.6)}<div class="center">${wispy(620)}
      <div style="font-weight:700;font-size:168px;letter-spacing:-5px;margin-top:70px">Deskwisp</div>
      <div style="font-weight:500;font-size:62px;line-height:1.25;text-align:center;opacity:.92;margin-top:28px;max-width:1100px">AI employees that run<br>your back office</div></div>`,
  ],
  "box-art-2160x2160": [
    2160,
    2160,
    `${sparks(2160, 2160, 2)}<div class="center">${wispy(940)}
      <div style="font-weight:700;font-size:250px;letter-spacing:-8px;margin-top:70px">Deskwisp</div></div>`,
  ],
  "tile-icon-300": [300, 300, `<div class="center">${wispy(232)}</div>`],
  "tile-icon-150": [150, 150, `<div class="center">${wispy(116)}</div>`],
  "tile-icon-71": [71, 71, `<div class="center">${wispy(56)}</div>`],
  "super-hero-art-3840x2160": [
    3840,
    2160,
    `${sparks(3840, 2160, 2.4)}
      <div style="position:absolute;left:300px;top:640px">${wispy(760)}</div>
      <div style="position:absolute;right:220px;top:260px;width:2240px;height:1400px;border-radius:44px;overflow:hidden;
        box-shadow:0 60px 160px rgba(22,19,43,.45),0 0 0 6px rgba(255,255,255,.35);background:#fff">
        <img src="data:image/png;base64,${shot}" style="width:100%;height:100%;object-fit:cover;object-position:left top"></div>`,
  ],
};

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
mkdirSync(`${root}docs/store`, { recursive: true });
for (const [name, [w, h, body]] of Object.entries(art)) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(page(w, h, body), { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  writeFileSync(`${root}docs/store/${name}.png`, await p.screenshot({ type: "png" }));
  await p.close();
}
await browser.close();
console.log("rendered the Store listing's pictures in docs/store/");
