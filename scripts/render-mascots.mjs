#!/usr/bin/env node
/**
 * Renders the bots' pictures (edge/public/mascot: PNG for Slack and Discord, JPG for Telegram), from the
 * same drawing the app uses (lib/mascot.ts). The logo is scripts/render-icons.mjs's. Run after
 * changing the mascot, copy edge/public/{mascot,brand} to cloud/public (Deskwisp Cloud serves them), then
 * deploy the cloud and edge/ (cd edge && fly deploy). Needs Chrome (Playwright).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { MAIN_COLOR, mascotMarkup, PICTURE_COLORS } from "../lib/mascot.ts";

const CREAM = "#FBFAFF";
const jobs = [{ name: `main-${MAIN_COLOR.slice(1)}`, markup: mascotMarkup("wispy", MAIN_COLOR), bg: CREAM }];
for (const c of PICTURE_COLORS) jobs.push({ name: `wisp-${c.slice(1)}`, markup: mascotMarkup("bot", c), bg: CREAM });

mkdirSync("edge/public/mascot", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const shot = async (markup, bg, size, scale, out, jpg) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;background:${bg};display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size * scale}" height="${size * scale}">${markup}</svg></body></html>`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size } });
  if (jpg) await page.screenshot({ path: out.replace(/\.png$/, ".jpg"), type: "jpeg", quality: 92, clip: { x: 0, y: 0, width: size, height: size } });
};
for (const j of jobs) await shot(j.markup, j.bg, 512, 0.8, `edge/public/mascot/${j.name}.png`, true);
await browser.close();
console.log(`rendered ${jobs.length} mascots`);
