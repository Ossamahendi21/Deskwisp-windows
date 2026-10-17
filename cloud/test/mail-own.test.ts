import "./mail-env.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AgentMailClient, type AgentMail } from "agentmail";
import { closeDb, query } from "../db.ts";
import { dmarcOf, inboundSignature, mailApi, MailError, newText } from "../mail.ts";
import { inboxAt } from "../provision.ts";
import { call, dropUsers, fakeHorafirm, fakeProvider, keyOf, newUserId, prepareDb, startCloud, until, type Got, type Listening } from "./core-fakes.ts";
import PostalMime from "postal-mime";

/**
 * Deskwisp Mail (cloud/mail.ts): the cloud answers AgentMail's calls itself, sends through Resend (a
 * fake here) and takes mail from its Cloudflare Worker (signed posts). The app's side is AgentMail's
 * own SDK pointed at the cloud, as lib/server/mail.ts does.
 */

const DOMAIN = "bots.deskwisp.test";
const SECRET = process.env.DESKWISP_MAIL_INBOUND_SECRET!;
let horafirm: Listening;
let cloud: Listening;
let resend: Listening & { got: Got[] };
const users: string[] = [];
const pods: string[] = [];

before(async () => {
  await prepareDb();
  horafirm = await fakeHorafirm();
  resend = await fakeProvider((g) => (g.path === "/emails" ? { json: { id: `re_${g.json?.headers?.["Message-ID"] ?? "x"}` } } : { status: 404 }));
  process.env.DESKWISP_UPSTREAM_RESEND = resend.url;
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM deskwisp.mail_pods WHERE pod_id = ANY($1::text[])", [pods]);
  await dropUsers(users);
  await Promise.all([horafirm?.close(), cloud?.close(), resend?.close()]);
  await closeDb();
});

/** A pod with a key and an inbox, as the session and the app make them. */
async function setUpPod(name: string) {
  const [, pod] = (await mailApi({ master: true }, "POST", "/v0/pods", {
    name,
    client_id: `test-${name}-${Date.now()}`,
  })) as [number, { pod_id: string }];
  pods.push(pod.pod_id);
  const [, key] = (await mailApi({ master: true }, "POST", `/v0/pods/${pod.pod_id}/api-keys`, { name })) as [number, { api_key: string }];
  const client = new AgentMailClient({
    apiKey: key.api_key,
    environment: {
      http: `${cloud.url}/mail`,
      websockets: `${cloud.url.replace(/^http/, "ws")}/mail`,
    },
    maxRetries: 0,
  });
  const inbox = await client.pods.inboxes.create(pod.pod_id, {
    ...inboxAt(name, `t${Date.now().toString(36)}`, DOMAIN),
    displayName: name,
    clientId: `box-${name}-${Date.now()}`,
  });
  return { podId: pod.pod_id, key: key.api_key, client, inbox };
}

/** A post as the Worker makes it. */
function inbound(to: string, raw: string, opts: { secret?: string; time?: number } = {}) {
  const time = String(opts.time ?? Math.floor(Date.now() / 1000));
  const body = Buffer.from(raw.replace(/\r?\n/g, "\r\n"));
  return fetch(`${cloud.url}/mail/inbound`, {
    method: "POST",
    headers: {
      "x-deskwisp-mail-time": time,
      "x-deskwisp-mail-to": to,
      "x-deskwisp-mail-from": "sender@example.com",
      "x-deskwisp-mail-signature": inboundSignature(opts.secret ?? SECRET, time, to, "sender@example.com", body),
    },
    body,
  });
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("inboxes: named by the bot and its handle on the cloud's domain, the same client id gives the same one, and taken or odd names are refused", async () => {
  const a = await setUpPod("wispy");
  assert.match(a.inbox.email, new RegExp(`^wispy\\.t[a-z0-9]+@${DOMAIN.replace(/\./g, "\\.")}$`));
  assert.equal(a.inbox.inboxId, a.inbox.email);
  const again = await a.client.pods.inboxes.create(a.podId, {
    username: "other",
    domain: DOMAIN,
    clientId: a.inbox.clientId!,
  });
  assert.equal(again.inboxId, a.inbox.inboxId, "same client id, same inbox");
  await assert.rejects(
    a.client.pods.inboxes.create(a.podId, {
      username: a.inbox.email.split("@")[0],
      domain: DOMAIN,
    }),
    (e: { statusCode?: number }) => e.statusCode === 409,
  );
  await assert.rejects(
    a.client.pods.inboxes.create(a.podId, {
      username: "support",
      domain: DOMAIN,
    }),
    (e: { statusCode?: number }) => e.statusCode === 409,
  );
  await assert.rejects(
    a.client.pods.inboxes.create(a.podId, {
      username: "x.y",
      domain: "elsewhere.test",
    }),
    (e: { statusCode?: number }) => e.statusCode === 400,
  );
  // A pod's key makes no pods and no keys.
  const r = await fetch(`${cloud.url}/mail/v0/pods`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${a.key}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  const none = await fetch(`${cloud.url}/mail/v0/inboxes/${a.inbox.inboxId}/messages`, { headers: { authorization: "Bearer dwm_nope" } });
  assert.equal(none.status, 401);
});

test("sending goes out through Resend from the bot's address, and is listed as sent", async () => {
  const a = await setUpPod("sam");
  const sent = await a.client.inboxes.messages.send(a.inbox.inboxId, {
    to: ["Pat <pat@example.com>"],
    cc: ["lee@example.com"],
    subject: "Hello",
    text: "Hi Pat",
    html: "<p>Hi Pat</p>",
  });
  const out = resend.got.find((g) => g.json?.subject === "Hello" && g.json?.from?.includes(a.inbox.email));
  assert.ok(out, "Resend was asked");
  assert.equal(out.headers.authorization, "Bearer re_test_key");
  assert.equal(out.json.from, `"sam" <${a.inbox.email}>`);
  assert.deepEqual(out.json.to, ["Pat <pat@example.com>"]);
  assert.deepEqual(out.json.cc, ["lee@example.com"]);
  assert.match(out.json.headers["Message-ID"], new RegExp(`^<${sent.messageId}@${DOMAIN.replace(/\./g, "\\.")}>$`));
  const list = await a.client.inboxes.messages.list(a.inbox.inboxId, {
    limit: 10,
  });
  assert.equal(list.messages.length, 1);
  assert.deepEqual(list.messages[0].labels, ["sent"]);
  assert.equal(list.messages[0].messageId, sent.messageId);
  await assert.rejects(
    a.client.inboxes.messages.send(a.inbox.inboxId, {
      to: ["not an address"],
      subject: "x",
      text: "y",
    }),
    (e: { statusCode?: number }) => e.statusCode === 400,
  );
});

test("mail coming in: signed by the Worker, stored, threaded with what it answers, pushed to the app's socket, attachments readable", async () => {
  const a = await setUpPod("max");
  const sent = await a.client.inboxes.messages.send(a.inbox.inboxId, {
    to: ["pat@example.com"],
    subject: "Quote",
    text: "Here's the quote.",
  });
  const socket = await a.client.websockets.connect({});
  const events: AgentMail.MessageReceivedEvent[] = [];
  let subscribed = false;
  socket.on("message", (e) => {
    if (e.type === "subscribed") subscribed = true;
    if (e.type === "event" && "eventType" in e && e.eventType === "message.received") events.push(e as AgentMail.MessageReceivedEvent);
  });
  await socket.waitForOpen();
  socket.sendSubscribe({
    type: "subscribe",
    podIds: [a.podId],
    eventTypes: ["message.received"],
  });
  await until(() => subscribed, "subscribed");

  const raw = [
    `Received: from mail.example.com by mx.cloudflare.net`,
    `From: Pat Doe <pat@example.com>`,
    `To: ${a.inbox.email}`,
    `Subject: Re: Quote`,
    `Message-ID: <reply-1@example.com>`,
    `In-Reply-To: <${sent.messageId}@${DOMAIN}>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="b1"`,
    ``,
    `--b1`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Looks good, go ahead.`,
    ``,
    `On Mon, 5 Oct 2026, ${a.inbox.email} wrote:`,
    `> Here's the quote.`,
    `--b1`,
    `Content-Type: image/png; name="photo.png"`,
    `Content-Disposition: attachment; filename="photo.png"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    PNG.toString("base64"),
    `--b1--`,
    ``,
  ].join("\n");
  const res = await inbound(a.inbox.email.replace("@", "+tag@").toUpperCase(), raw);
  assert.equal(res.status, 200, await res.clone().text());
  const got = (await res.json()) as { message_id: string; duplicate: boolean };
  assert.equal(got.duplicate, false);

  const e = await until(() => events[0], "the socket's event");
  assert.equal(e.message.messageId, got.message_id);
  assert.equal(e.message.threadId, sent.threadId, "the reply is in the bot's thread");
  assert.equal(e.message.from, "Pat Doe <pat@example.com>");
  assert.equal(e.message.subject, "Re: Quote");
  assert.equal(e.message.extractedText, "Looks good, go ahead.");
  assert.equal(e.thread.messageCount, 2);

  const full = await a.client.inboxes.messages.get(a.inbox.inboxId, got.message_id);
  assert.ok(full.labels.includes("received"));
  const att = full.attachments?.[0];
  assert.equal(att?.filename, "photo.png");
  assert.equal(att?.contentType, "image/png");
  const file = await a.client.inboxes.messages.getAttachment(a.inbox.inboxId, got.message_id, att!.attachmentId);
  const bytes = Buffer.from(await (await fetch(file.downloadUrl)).arrayBuffer());
  assert.deepEqual(bytes, PNG);

  const thread = await a.client.inboxes.threads.get(a.inbox.inboxId, sent.threadId);
  assert.deepEqual(
    thread.messages.map((m) => m.messageId),
    [sent.messageId, got.message_id],
  );

  // The same email delivered again is the same message, and no second event.
  const twice = (await (await inbound(a.inbox.email, raw)).json()) as {
    message_id: string;
    duplicate: boolean;
  };
  assert.deepEqual(twice, {
    ok: true,
    message_id: got.message_id,
    duplicate: true,
  });

  // A reply goes to Pat, "Re:", threaded on Pat's Message-ID.
  await a.client.inboxes.messages.reply(a.inbox.inboxId, got.message_id, {
    text: "Done.",
  });
  const back = resend.got.at(-1)!;
  assert.deepEqual(back.json.to, ["Pat Doe <pat@example.com>"]);
  assert.equal(back.json.subject, "Re: Quote");
  assert.equal(back.json.headers["In-Reply-To"], "<reply-1@example.com>");
  assert.match(back.json.headers.References, /<reply-1@example\.com>$/);
  const search = await a.client.inboxes.messages.search(a.inbox.inboxId, {
    q: "go ahead",
    limit: 10,
  });
  assert.deepEqual(
    search.messages.map((m) => m.messageId),
    [got.message_id],
  );
  socket.close();
  assert.equal(events.length, 1);
});

test("the inbound door: unsigned, stale or wrongly signed posts are refused, and an address nobody has is a 404 (the Worker bounces it)", async () => {
  const a = await setUpPod("door");
  const raw = `From: x@example.com\nTo: ${a.inbox.email}\nSubject: hi\n\nhello\n`;
  assert.equal((await inbound(a.inbox.email, raw, { secret: "wrong-secret" })).status, 401);
  assert.equal(
    (
      await inbound(a.inbox.email, raw, {
        time: Math.floor(Date.now() / 1000) - 3600,
      })
    ).status,
    401,
  );
  const plain = await fetch(`${cloud.url}/mail/inbound`, {
    method: "POST",
    body: raw,
  });
  assert.equal(plain.status, 401);
  assert.equal((await inbound(`nobody.here@${DOMAIN}`, raw)).status, 404);
  assert.equal((await inbound(a.inbox.email, raw)).status, 200);
});

test("one pod's key reaches none of another pod's mail", async () => {
  const a = await setUpPod("alpha");
  const b = await setUpPod("beta");
  await assert.rejects(b.client.inboxes.messages.list(a.inbox.inboxId), (e: { statusCode?: number }) => e.statusCode === 404);
  await assert.rejects(b.client.pods.inboxes.get(a.podId, a.inbox.inboxId), (e: { statusCode?: number }) => e.statusCode === 404);
  await assert.rejects(
    b.client.inboxes.messages.send(a.inbox.inboxId, {
      to: ["x@example.com"],
      subject: "s",
      text: "t",
    }),
    (e: { statusCode?: number }) => e.statusCode === 404,
  );
  await assert.rejects(mailApi({ podId: b.podId }, "GET", `/v0/pods/${a.podId}/inboxes/${a.inbox.inboxId}`), (e) => e instanceof MailError && e.status === 404);
});

test("DMARC counts only as the receiving side found it: above the first Received header", async () => {
  const mk = async (headers: string) => PostalMime.parse(`${headers}\r\nFrom: Me <me@gmail.com>\r\nSubject: s\r\n\r\nbody\r\n`);
  const ours = await mk(
    "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com\r\nReceived: from mail-x.google.com by mx.cloudflare.net",
  );
  assert.equal(dmarcOf(ours, "me@gmail.com"), "pass");
  const forged = await mk("Received: from evil.example by mx.cloudflare.net\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com");
  assert.equal(dmarcOf(forged, "me@gmail.com"), "none", "written by the sender, below Cloudflare's Received");
  const failed = await mk("Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=gmail.com\r\nReceived: from x by mx.cloudflare.net");
  assert.equal(dmarcOf(failed, "me@gmail.com"), "fail");
  const other = await mk("Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=other.com\r\nReceived: from x by mx.cloudflare.net");
  assert.equal(dmarcOf(other, "me@gmail.com"), "none", "a pass for another domain");
});

test("what's new in a reply: the text above the quoted email", () => {
  assert.equal(newText("Sounds good.\n\nOn Tue, Oct 6, 2026 at 9:00 AM Sam <sam@x.com>\nwrote:\n> old"), "Sounds good.");
  assert.equal(newText("Yes\n-----Original Message-----\nFrom: a"), "Yes");
  assert.equal(newText("Yes\n\nFrom: Sam\nSent: Monday\nTo: me"), "Yes");
  assert.equal(newText("Top\n> quoted\n> more\n"), "Top");
  assert.equal(newText("Plain email, nothing quoted."), "Plain email, nothing quoted.");
});

test("the session hands the app Deskwisp Mail: its own pod and key, the cloud's /mail, dotted addresses", async () => {
  const userId = newUserId("ownmail");
  users.push(userId);
  const r = await call(cloud.url, "POST", "/v1/session", {
    key: keyOf(userId),
  });
  assert.equal(r.status, 200, r.text);
  const m = r.json.agentmail;
  assert.match(m.podId, /^pod_/);
  assert.match(m.apiKey, /^dwm_/);
  assert.equal(m.api, "/mail");
  assert.equal(m.addresses, "dotted");
  assert.equal(m.domain, DOMAIN);
  pods.push(m.podId);
  const again = await call(cloud.url, "POST", "/v1/session", {
    key: keyOf(userId),
  });
  assert.equal(again.json.agentmail.podId, m.podId);
  assert.equal(again.json.agentmail.apiKey, m.apiKey, "the same key every time");
  // A pod kept from AgentMail is replaced by one of Deskwisp Mail's.
  await query("UPDATE deskwisp.cloud_accounts SET agentmail_pod_id = 'a1b2c3d4-agentmail-pod' WHERE user_id = $1", [userId]);
  const moved = await call(cloud.url, "POST", "/v1/session", {
    key: keyOf(userId),
  });
  assert.match(moved.json.agentmail.podId, /^pod_/);
  assert.notEqual(moved.json.agentmail.podId, "a1b2c3d4-agentmail-pod");
  pods.push(moved.json.agentmail.podId);
  const client = new AgentMailClient({
    apiKey: moved.json.agentmail.apiKey,
    environment: {
      http: `${cloud.url}/mail`,
      websockets: `${cloud.url.replace(/^http/, "ws")}/mail`,
    },
    maxRetries: 0,
  });
  const box = await client.pods.inboxes.create(moved.json.agentmail.podId, {
    ...inboxAt("wispy", "sess", DOMAIN),
  });
  assert.equal(box.email, `wispy.sess@${DOMAIN}`);
});
