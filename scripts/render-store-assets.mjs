#!/usr/bin/env node
/**
 * Renders the Microsoft Store package's pictures (build/appx/, which electron-builder puts in the MSIX:
 * scripts/release-store.sh) from the one drawing in lib/mascot.ts, as scripts/render-icons.mjs does the
 * other logo files. Run after changing the logo. Needs a Chromium: Playwright's, or CHROME=<path>.
 *
 *   Square44x44Logo     the taskbar, Start's list and the title bar (with sizes Windows picks by pixel)
 *   Square150x150Logo   Start's medium tile         Wide310x150Logo   Start's wide tile
 *   SmallTile           Start's small tile          LargeTile         Start's large tile
 *   StoreLogo           the Store and the installer
 *   SplashScreen        what shows while Deskwisp opens
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { ACCENT, logoMarkup } from "../lib/mascot.ts";

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");

/**
 * A `w`×`h` picture: the logo `logo` pixels across in the middle. "circle" is the round logo on nothing
 * (icons Windows puts on its own backgrounds); "tile" is Wispy alone on violet to the edges.
 */
async function png(w, h, logo, look) {
  const inner = look === "circle" ? logoMarkup("circle") : logoMarkup("square").replace(/^<rect[^>]*\/>/, "");
  const x = (w - logo) / 2;
  const y = (h - logo) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    (look === "tile" ? `<rect width="${w}" height="${h}" fill="${ACCENT}"/>` : "") +
    `<g transform="translate(${x} ${y}) scale(${logo / 40})">${inner}</g></svg>`;
  const url = await page.evaluate(
    async ({ svg, w, h }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c.toDataURL("image/png");
    },
    { svg, w, h },
  );
  return Buffer.from(url.split(",")[1], "base64");
}

const dir = "build/appx";
mkdirSync(dir, { recursive: true });
const put = async (name, w, h, logo, look) => writeFileSync(`${dir}/${name}.png`, await png(w, h, logo, look));

// At 100% and 200% scale, and the plain sizes the taskbar and Explorer take (unplated: no tile behind them).
for (const [scale, k] of [["scale-100", 1], ["scale-200", 2]]) {
  await put(`Square44x44Logo.${scale}`, 44 * k, 44 * k, 44 * k, "circle");
  await put(`Square150x150Logo.${scale}`, 150 * k, 150 * k, 120 * k, "tile");
  await put(`Wide310x150Logo.${scale}`, 310 * k, 150 * k, 120 * k, "tile");
  await put(`SmallTile.${scale}`, 71 * k, 71 * k, 58 * k, "tile");
  await put(`LargeTile.${scale}`, 310 * k, 310 * k, 240 * k, "tile");
  await put(`StoreLogo.${scale}`, 50 * k, 50 * k, 50 * k, "circle");
  await put(`SplashScreen.${scale}`, 620 * k, 300 * k, 220 * k, "tile");
}
for (const size of [16, 24, 32, 48, 256]) {
  await put(`Square44x44Logo.targetsize-${size}`, size, size, size, "circle");
  await put(`Square44x44Logo.targetsize-${size}_altform-unplated`, size, size, size, "circle");
}
await browser.close();
console.log(`rendered the Store package's pictures in ${dir}/`);
