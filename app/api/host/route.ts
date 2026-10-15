import { update } from "@/lib/server/store";
import type { Host } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

/** Switch where new sessions run: Chrome windows on this PC, or Horafirm cloud computers. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { host } = (await request.json()) as { host?: Host };
  if (host !== "mac" && host !== "horafirm") return Response.json({ error: "host must be mac or horafirm" }, { status: 400 });
  update((s) => (s.host = host));
  return Response.json({ host });
}
