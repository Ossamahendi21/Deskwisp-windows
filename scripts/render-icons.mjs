#!/usr/bin/env node
/**
 * Renders every Deskwisp logo file from the one drawing in lib/mascot.ts (logoMarkup): Wispy in white on
 * violet. Run after changing the logo, then rebuild the app, deploy the website and Deskwisp Cloud, and
 * deploy edge/ (cd edge && fly deploy). Needs Chrome, or CHROME=<path to a Chromium>.
 *
 *   assets/icon.svg                        Deskwisp Cloud's pages
 *   desktop/icon.png                       the app's window and taskbar
 *   build/icon.ico                         Deskwisp.exe, its installer and uninstaller
 *   app/favicon.ico                        the app's pages
 *   deploy/vps/site/deskwisp.png           the website's icon, and its logo for search engines
 *   deploy/vps/site/apple-touch-icon.png   the website saved to a phone's home screen
 *   {edge,cloud}/public/brand/deskwisp-{512,1024}.png
 *                                          the picture Slack, Discord and Telegram show, and the sign-in pages
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { logoMarkup, logoSvg } from "../lib/mascot.ts";

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: "chrome" });
const page = await browser.newPage();

/** The logo as a PNG, `size` pixels square: a circle on nothing, or violet to the edges. Drawn on a canvas
 * at that size, so even the 16-pixel one is drawn for 16 pixels rather than shrunk. */
await page.setContent("<html><body></body></html>");
async function png(size, shape) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">${logoMarkup(shape)}</svg>`;
  const url = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d").drawImage(img, 0, 0, size, size);
      return c.toDataURL("image/png");
    },
    { svg, size },
  );
  return Buffer.from(url.split(",")[1], "base64");
}

/** An .ico holding a PNG for each size (Windows takes PNGs in icons from Vista on). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const write = (path, data) => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, data);
};

write("assets/icon.svg", logoSvg("circle"));
write("desktop/icon.png", await png(1024, "circle"));
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const icon = ico(await Promise.all(sizes.map(async (size) => ({ size, data: await png(size, "circle") }))));
write("build/icon.ico", icon);
write("app/favicon.ico", icon);
write("deploy/vps/site/deskwisp.png", await png(512, "circle"));
write("deploy/vps/site/apple-touch-icon.png", await png(180, "square"));
for (const dir of ["edge/public/brand", "cloud/public/brand"]) {
  write(`${dir}/deskwisp-512.png`, await png(512, "square"));
  write(`${dir}/deskwisp-1024.png`, await png(1024, "square"));
}
await browser.close();
console.log("rendered the logo: assets, desktop, build, app, the website, edge and cloud");
