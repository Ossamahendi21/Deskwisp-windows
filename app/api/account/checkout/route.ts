import { loadHorafirmKey } from "@/lib/server/horafirm-auth";
import { deskwispBillingLink } from "@/lib/server/plan";
import { trackServerEvent } from "@/lib/server/analytics";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Pay for Deskwisp Pro or Max ({tier: "pro_deskwisp" | "max_deskwisp"}): a Stripe Checkout page from Horafirm, for the
 * app to open in the browser (an upgrade from Pro is Horafirm's page to confirm the change). Asked with the
 * user's Horafirm key, so it stays on the server. Answers {url}, or {error} saying why not ({soon: true}
 * when Horafirm can't take payment for Deskwisp plans yet).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { tier } = (await request.json().catch(() => ({}))) as { tier?: unknown };
  if (tier !== "pro_deskwisp" && tier !== "max_deskwisp") return Response.json({ error: "Pick Pro or Max." }, { status: 400 });
  const key = await loadHorafirmKey();
  if (!key) return Response.json({ error: "Sign in to Deskwisp first." }, { status: 401 });
  const link = await deskwispBillingLink(key, { tier });
  if ("url" in link) trackServerEvent("deskwisp_checkout_started", { to_plan: tier });
  return "url" in link ? Response.json(link) : Response.json({ error: link.error, ...(link.soon ? { soon: true } : {}) }, { status: link.status });
}
