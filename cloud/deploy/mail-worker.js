/**
 * Deskwisp Mail's Cloudflare Email Worker (cloud/mail.ts): every email Cloudflare Email Routing takes for
 * the bots' domain (its catch-all rule, "Send to a Worker") is posted to Deskwisp Cloud, signed, as it
 * arrived. Nothing to build: paste this file into the Worker's editor in Cloudflare's dashboard.
 *
 * The Worker's settings (Settings → Variables and Secrets):
 *   CLOUD_URL       where Deskwisp Cloud is reached, DESKWISP_CLOUD_PUBLIC_URL (https://…/api), no "/" at the end
 *   INBOUND_SECRET  a secret: the same value as the cloud's DESKWISP_MAIL_INBOUND_SECRET
 *
 * An address no bot has is turned down (the sender gets a bounce). When the cloud can't be reached,
 * the Worker fails, and Cloudflare tells the sending server so it can try again later.
 */

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const time = String(Math.floor(Date.now() / 1000));
    const to = String(message.to);
    const from = String(message.from);
    // HMAC-SHA256 over "<time>\n<to>\n<from>\n" and the email itself (cloud/mail.ts inboundSignature).
    const head = new TextEncoder().encode(`${time}\n${to}\n${from}\n`);
    const signed = new Uint8Array(head.length + raw.length);
    signed.set(head);
    signed.set(raw, head.length);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INBOUND_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hex(await crypto.subtle.sign("HMAC", key, signed));

    const res = await fetch(`${String(env.CLOUD_URL).replace(/\/+$/, "")}/mail/inbound`, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-deskwisp-mail-time": time,
        "x-deskwisp-mail-to": to,
        "x-deskwisp-mail-from": from,
        "x-deskwisp-mail-signature": signature,
      },
      body: raw,
    });
    if (res.status === 404) return message.setReject("No one here has this address");
    if (!res.ok) throw new Error(`Deskwisp Cloud answered ${res.status}`);
  },
};
