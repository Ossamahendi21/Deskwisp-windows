/**
 * A check of the computer template on real E2B, without the app: makes one computer, brings its
 * desktop up, takes a screenshot, pauses it and wakes it, then deletes it. A run costs about a cent.
 *
 *   node --experimental-strip-types --env-file=dcloud/.env dcloud/scripts/smoke-e2b.ts
 *
 * The screenshots land in dcloud-smoke-1.png (fresh) and dcloud-smoke-2.png (after the pause).
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { ready, screens, screenshot, run } from "../src/desktop.ts";
import { E2BProvider } from "../src/providers/e2b.ts";

const cfg = loadConfig({ ...process.env, DESKWISP_PROVIDER: "e2b" });
const provider = new E2BProvider({ apiKey: cfg.e2bApiKey!, template: cfg.e2bTemplate, idleMs: 5 * 60_000 });
const t0 = Date.now();
const step = (what: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

let id: string | null = null;
let failed = false;
try {
  step(`making a computer from the "${cfg.e2bTemplate}" template`);
  let box = await provider.create({ cpu: cfg.cpu, ramGb: cfg.ramGb, meta: { purpose: "smoke" } });
  id = box.id;
  step(`made ${id}`);

  await ready(box, "smoke123");
  step(`desktop up; screens: ${JSON.stringify(await screens(box))}`);

  const tools = await run(box, "for t in google-chrome codex node xdotool x11vnc websockify; do printf '%s ' $t; command -v $t >/dev/null && echo ok || echo MISSING; done", 30);
  console.log(tools.output.trim());

  writeFileSync("dcloud-smoke-1.png", await screenshot(box, 99, 1, "png"));
  step("screenshot saved: dcloud-smoke-1.png");

  // The live view goes through websockify on 6080: reachable from outside means the app's VNC can work.
  const res = await fetch(box.portUrl(6080), { signal: AbortSignal.timeout(15_000) }).catch((e) => e as Error);
  step(res instanceof Error ? `live view port: NOT reachable (${res.message})` : `live view port reachable (HTTP ${res.status})`);

  step("pausing");
  await provider.pause(id);
  step(`state after pause: ${await provider.state(id)}`);

  step("waking it");
  box = await provider.open(id);
  step(`state: ${await provider.state(id)}; screens: ${JSON.stringify(await screens(box))}`);
  writeFileSync("dcloud-smoke-2.png", await screenshot(box, 99, 1, "png"));
  step("screenshot saved: dcloud-smoke-2.png");
} catch (e) {
  failed = true;
  console.error("FAILED:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  if (id) {
    await provider.kill(id).catch((e) => console.error(`couldn't delete ${id}: ${e}. Delete it in the E2B dashboard.`));
    step(`deleted ${id}`);
  }
}
console.log(failed ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
process.exit(failed ? 1 : 0);
