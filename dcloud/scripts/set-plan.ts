/**
 * Put a user on a plan by hand, until billing (Polar) does it: the paid plan's AI credit for a month is
 * granted (once per run), and the services server (cloud/) is told, as billing will.
 *
 *   node --experimental-strip-types --env-file=dcloud/.env dcloud/scripts/set-plan.ts <email or user id> <free|pro|max>
 *
 * It uses the same database as the server (DATABASE_URL in dcloud/.env).
 */
import { Billing } from "../src/billing.ts";
import { Computers } from "../src/computers.ts";
import { loadConfig } from "../src/config.ts";
import { isTier, PLANS } from "../src/plans.ts";
import { JsonStore } from "../src/store.ts";
import { PgStore } from "../src/store-pg.ts";
import { LocalProvider } from "../src/providers/local.ts";
import { join } from "node:path";

const [who, word] = process.argv.slice(2);
const tier = `${word ?? ""}_deskwisp`;
if (!who || !isTier(tier)) {
  console.error("Usage: set-plan.ts <email or user id> <free|pro|max>");
  process.exit(2);
}
// The plan only touches accounts: no computers are made, so no provider key is needed.
const cfg = loadConfig({ ...process.env, DESKWISP_PROVIDER: "local" });
const store = cfg.databaseUrl ? await PgStore.open(cfg.databaseUrl) : new JsonStore(join(cfg.dataDir, "store.json"));
try {
  const user = who.includes("@") ? await store.userByEmail(who) : await store.user(who);
  if (!user) throw new Error(`No user ${who} (they sign in to Deskwisp once first)`);
  const planOf = async () => tier;
  const computers = new Computers(cfg, store, new LocalProvider(join(cfg.dataDir, "computers")), planOf);
  const billing = new Billing(cfg, store, computers, planOf);
  const r = await billing.changePlan(user.id, tier);
  computers.stop();
  console.log(
    `${user.email ?? user.id} is on ${PLANS[tier].name} now` +
      (r.granted !== null ? `, with $${(r.granted / 1e6).toFixed(2)} of AI credit for the month` : "") +
      (cfg.servicesUrl && cfg.planSecret ? "; the services server was told." : "; set DESKWISP_SERVICES_URL and DESKWISP_CLOUD_PLAN_SECRET to tell the services server too."),
  );
} finally {
  await store.close();
}
