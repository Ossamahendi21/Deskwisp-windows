/**
 * Builds the Deskwisp computer template on E2B, from dcloud/template/e2b.Dockerfile with the repo as
 * its build context. Run it once (and again after changing the Dockerfile or vm/):
 *
 *   node --experimental-strip-types --env-file=dcloud/.env dcloud/template/build.ts
 *
 * Then set E2B_TEMPLATE=deskwisp-computer (the default) in Deskwisp Cloud's environment.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultBuildLogger, Template } from "e2b";

const root = fileURLToPath(new URL("../../", import.meta.url));
const name = process.env.E2B_TEMPLATE || "deskwisp-computer";
if (!process.env.E2B_API_KEY) {
  console.error("Set E2B_API_KEY first (e2b.dev → Dashboard → API Keys).");
  process.exit(1);
}

const template = Template({ fileContextPath: root, fileIgnorePatterns: ["node_modules", ".next", "dist-win", "dist-desktop", ".git", ".data", ".dcloud-data"] }).fromDockerfile(
  readFileSync(new URL("./e2b.Dockerfile", import.meta.url), "utf8"),
);

const built = await Template.build(template, name, {
  // The size of each computer: what E2B bills by the second while it runs.
  cpuCount: Number(process.env.DESKWISP_COMPUTER_CPU) || 2,
  memoryMB: (Number(process.env.DESKWISP_COMPUTER_RAM_GB) || 4) * 1024,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`Built ${name}:`, JSON.stringify(built));
