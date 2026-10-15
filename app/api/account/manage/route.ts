import { loadHorafirmKey } from "@/lib/server/horafirm-auth";
import { deskwispBillingLink } from "@/lib/server/plan";
import { trackServerEvent } from "@/lib/server/analytics";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Change or cancel the paid Deskwisp plan, update the card, see invoices: Horafirm's page for it (Stripe's
 * billing portal, Deskwisp plans only), for the app to open in the browser. Answers {url}, or {error}.
 */
export async function POST() {
  const unready = notReady();
  if (unready) return unready;
  const key = await loadHorafirmKey();
  if (!key) return Response.json({ error: "Sign in with Horafirm first." }, { status: 401 });
  const link = await deskwispBillingLink(key, "manage");
  if ("url" in link) trackServerEvent("deskwisp_billing_portal_opened", {});
  return "url" in link ? Response.json(link) : Response.json({ error: link.error, ...(link.soon ? { soon: true } : {}) }, { status: link.status });
}
