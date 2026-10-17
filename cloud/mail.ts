import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import PostalMime, { type Address, type Email } from "postal-mime";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.ts";
import { query, tx } from "./db.ts";
import { HttpError, readBody, sendJson, type Route, type Upgrade } from "./http.ts";

/**
 * Deskwisp Mail: bots' email run by this cloud, in place of AgentMail, when RESEND_API_KEY and
 * DESKWISP_MAIL_DOMAIN are set (config.ownMail). It costs nothing past the domain:
 *
 * - **In:** Cloudflare Email Routing takes every email to the domain (its catch-all) and a small Worker
 *   (deploy/mail-worker.js) posts it here, signed (POST /mail/inbound). Cloudflare's catch-all works on
 *   the domain itself only, never a subdomain, so a bot's address is <bot>.<handle>@<domain>
 *   (wispy.tiger@deskwisp.com) rather than wispy@tiger.deskwisp.bot.
 * - **Out:** Resend sends it, from the bot's own address (the domain verified there).
 * - **The app:** it already speaks AgentMail through AgentMail's SDK, so this answers the same calls it
 *   makes, at /mail/v0/... (and its WebSocket at /mail/v0), with the same JSON. The session hands the
 *   app a key that reaches only the user's own pod, as AgentMail's did. The rest of the cloud
 *   (session.ts, provision.ts) calls mailApi() in the same process, with every pod in reach.
 *
 * Kept in Postgres (db/migrations/0014_mail.sql). Attachments' bytes are kept 30 days (sweepMail),
 * then only their names and sizes.
 */

/* ---------------- Ids, keys and addresses ---------------- */

const id = (prefix: string) =>
  `${prefix}_${randomBytes(15)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The local part of an address: what the app makes (wispy.tiger, wispy2.tiger), and nothing the domain's own people use. */
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;
const ROLE = new Set([
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "admin",
  "administrator",
  "root",
  "support",
  "security",
  "noreply",
  "no-reply",
  "hello",
  "contact",
  "info",
  "billing",
  "sales",
  "team",
  "help",
  "privacy",
  "legal",
  "mailer-daemon",
]);

const ADDRESS = /^[^\s@<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** "Name <a@b.c>" or "a@b.c" → a@b.c, lowercased. */
const bare = (x: string) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim().toLowerCase();
/** An address with its "+tag" taken off (wispy.tiger+news@d → wispy.tiger@d). */
const untagged = (a: string) => a.replace(/\+[^@]*@/, "@");

/** Who's calling: the cloud itself (every pod), or the app with a pod's key (that pod only). */
export type MailCaller = { master: true } | { podId: string };

/** A key's pod, remembered a minute. */
const keys = new Map<string, { podId: string | null; at: number }>();
async function podOfKey(key: string): Promise<string | null> {
  const h = sha256(key);
  const hit = keys.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.podId;
  const r = await query<{ pod_id: string }>("SELECT pod_id FROM deskwisp.mail_keys WHERE key_hash = $1", [h]);
  const podId = r.rows[0]?.pod_id ?? null;
  keys.set(h, { podId, at: Date.now() });
  return podId;
}

/** The key in a request: Bearer, or ?api_key= (AgentMail's SDK puts it on its WebSocket's address). */
function keyOf(req: IncomingMessage, url: URL) {
  const auth = req.headers.authorization ?? "";
  return /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || url.searchParams.get("api_key") || "";
}

/* ---------------- Errors ---------------- */

/** An answer that isn't 2xx, with AgentMail's shape ({ name, message }). */
export class MailError extends Error {
  status: number;
  name: string;
  constructor(status: number, message: string, name = status === 404 ? "NotFoundError" : status === 409 ? "AlreadyExistsError" : "ValidationError") {
    super(message);
    this.status = status;
    this.name = name;
  }
}
const notFound = (what: string) => new MailError(404, `${what} not found`);

/* ---------------- Rows into AgentMail's JSON ---------------- */

type PodRow = {
  pod_id: string;
  name: string;
  client_id: string | null;
  created_at: Date;
  updated_at: Date;
};
type BoxRow = {
  inbox_id: string;
  pod_id: string;
  display_name: string | null;
  client_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};
type MsgRow = {
  inbox_id: string;
  message_id: string;
  thread_id: string;
  labels: string[];
  at: Date;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  reply_to: string[];
  subject: string | null;
  preview: string | null;
  text_body: string | null;
  html_body: string | null;
  rfc_id: string | null;
  in_reply_to: string | null;
  refs: string[];
  headers: Record<string, string>;
  dmarc: string | null;
  size: number;
  created_at: Date;
  updated_at: Date;
};
type FileRow = {
  attachment_id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  disposition: string | null;
  content_id: string | null;
  size: number;
};

const podJson = (p: PodRow) => ({
  pod_id: p.pod_id,
  name: p.name,
  client_id: p.client_id,
  created_at: p.created_at.toISOString(),
  updated_at: p.updated_at.toISOString(),
});
const boxJson = (b: BoxRow) => ({
  pod_id: b.pod_id,
  inbox_id: b.inbox_id,
  email: b.inbox_id,
  display_name: b.display_name,
  client_id: b.client_id,
  metadata: b.metadata,
  created_at: b.created_at.toISOString(),
  updated_at: b.updated_at.toISOString(),
});
const fileJson = (f: FileRow) => ({
  attachment_id: f.attachment_id,
  filename: f.filename,
  size: f.size,
  content_type: f.content_type,
  content_disposition: f.disposition,
  content_id: f.content_id,
});

/** A message as AgentMail answers it: the list's item (`full` false), or the whole email. */
function messageJson(m: MsgRow, files: FileRow[], full: boolean) {
  const sent = m.labels.includes("sent");
  return {
    inbox_id: m.inbox_id,
    thread_id: m.thread_id,
    message_id: m.message_id,
    labels: m.labels,
    timestamp: m.at.toISOString(),
    from: m.from_addr,
    reply_to: m.reply_to.length ? m.reply_to : null,
    to: m.to_addrs,
    cc: m.cc_addrs.length ? m.cc_addrs : null,
    subject: m.subject,
    preview: m.preview,
    ...(full
      ? {
          text: m.text_body,
          html: m.html_body,
          extracted_text: m.text_body ? newText(m.text_body) || null : null,
        }
      : {}),
    attachments: files.length ? files.map(fileJson) : null,
    in_reply_to: m.in_reply_to,
    references: m.refs.length ? m.refs : null,
    headers: m.headers,
    size: m.size,
    created_at: m.created_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
    // The cloud's own verdict on who sent it (lib/server/mail.ts isFromOwner reads it before any header): none for what a bot sent.
    ...(sent ? {} : { authentication_results: { dmarc: m.dmarc ?? "none" } }),
  };
}

const MSG_COLUMNS =
  "inbox_id, message_id, thread_id, labels, at, from_addr, to_addrs, cc_addrs, reply_to, subject, preview, text_body, html_body, rfc_id, in_reply_to, refs, headers, dmarc, size, created_at, updated_at";
const ITEM_COLUMNS = MSG_COLUMNS.replace(", text_body, html_body", ", NULL::text AS text_body, NULL::text AS html_body");

async function filesOf(inboxId: string, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, FileRow[]>();
  const r = await query<FileRow>(
    "SELECT attachment_id, message_id, filename, content_type, disposition, content_id, size FROM deskwisp.mail_files WHERE inbox_id = $1 AND message_id = ANY($2::text[]) ORDER BY created_at, attachment_id",
    [inboxId, messageIds],
  );
  const by = new Map<string, FileRow[]>();
  for (const f of r.rows) by.set(f.message_id, [...(by.get(f.message_id) ?? []), f]);
  return by;
}

async function withFiles(rows: MsgRow[], full: boolean) {
  const files = rows.length
    ? await filesOf(
        rows[0].inbox_id,
        rows.map((m) => m.message_id),
      )
    : new Map<string, FileRow[]>();
  return rows.map((m) => messageJson(m, files.get(m.message_id) ?? [], full));
}

/* ---------------- Text ---------------- */

const htmlText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** What's new in a reply: the text above the quoted email ("On … wrote:", "> …", Outlook's "From: … Sent: …"). */
export function newText(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines.slice(i, i + 3).join(" ");
    const divider = /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l.trim());
    const outlook = /^From:\s/i.test(l) && /\b(Sent|Date):\s/i.test(next);
    // "On Mon, 5 Oct 2026 at 10:00, Sam <sam@x.com> wrote:", sometimes folded over two or three lines.
    const onWrote =
      /^On\b/i.test(l) &&
      lines.slice(i, i + 3).some((_, k) =>
        /\bwrote:\s*$/i.test(
          lines
            .slice(i, i + k + 1)
            .join(" ")
            .trim(),
        ),
      );
    if (divider || outlook || onWrote) {
      end = i;
      break;
    }
    if (/^>/.test(l) && lines.slice(i).every((x) => /^>/.test(x) || !x.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).join("\n").trim();
}

const previewOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200) || null;

/* ---------------- Pods, keys, inboxes ---------------- */

async function boxFor(who: MailCaller, inboxId: string): Promise<BoxRow> {
  const r = await query<BoxRow>("SELECT * FROM deskwisp.mail_boxes WHERE inbox_id = $1", [inboxId.trim().toLowerCase()]);
  const b = r.rows[0];
  if (!b || ("podId" in who && b.pod_id !== who.podId)) throw notFound("Inbox");
  return b;
}

function onlyMaster(who: MailCaller) {
  if (!("master" in who)) throw new MailError(403, "This key can't do that", "ForbiddenError");
}
function podReach(who: MailCaller, podId: string) {
  if ("podId" in who && who.podId !== podId) throw notFound("Pod");
}

async function makePod(body: { name?: string; client_id?: string }) {
  const clientId = typeof body.client_id === "string" && body.client_id.trim() ? body.client_id.trim() : null;
  if (clientId) {
    const had = await query<PodRow>("SELECT * FROM deskwisp.mail_pods WHERE client_id = $1", [clientId]);
    if (had.rows[0]) return podJson(had.rows[0]);
  }
  const r = await query<PodRow>(
    "INSERT INTO deskwisp.mail_pods (pod_id, name, client_id) VALUES ($1, $2, $3) ON CONFLICT (client_id) DO UPDATE SET updated_at = deskwisp.mail_pods.updated_at RETURNING *",
    [id("pod"), (body.name ?? "").toString().slice(0, 200) || "pod", clientId],
  );
  return podJson(r.rows[0]);
}

async function makeBox(
  who: MailCaller,
  podId: string,
  body: {
    username?: string;
    domain?: string;
    display_name?: string;
    client_id?: string;
    metadata?: unknown;
  },
) {
  podReach(who, podId);
  const pod = await query("SELECT 1 FROM deskwisp.mail_pods WHERE pod_id = $1", [podId]);
  if (!pod.rowCount) throw notFound("Pod");
  const clientId = typeof body.client_id === "string" && body.client_id.trim() ? body.client_id.trim().slice(0, 300) : null;
  // The same client id hands back the same inbox (AgentMail does the same), so a retry never makes two.
  if (clientId) {
    const had = await query<BoxRow>("SELECT * FROM deskwisp.mail_boxes WHERE client_id = $1", [clientId]);
    if (had.rows[0]) {
      if (had.rows[0].pod_id !== podId) throw new MailError(409, "That client id is another pod's");
      return boxJson(had.rows[0]);
    }
  }
  const domain = config.mailDomain();
  if (!domain) throw new MailError(503, "Mail has no domain here (DESKWISP_MAIL_DOMAIN)", "ServiceUnavailableError");
  const want = (body.domain ?? "").toString().trim().toLowerCase();
  if (want && want !== domain) throw new MailError(400, `Addresses here are on ${domain} only`);
  const local = (body.username ?? "").toString().trim().toLowerCase();
  if (!LOCAL.test(local) || local.includes("..")) throw new MailError(400, "That username can't be an address");
  if (ROLE.has(local.split(".")[0])) throw new MailError(409, "That address is taken");
  const address = `${local}@${domain}`;
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : null;
  const r = await query<BoxRow>(
    `INSERT INTO deskwisp.mail_boxes (inbox_id, pod_id, display_name, client_id, metadata) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING *`,
    [address, podId, (body.display_name ?? "").toString().slice(0, 100) || null, clientId, metadata ? JSON.stringify(metadata) : null],
  );
  if (!r.rows[0]) {
    // Two calls with the same client id at once: the other one's inbox.
    const same = clientId ? await query<BoxRow>("SELECT * FROM deskwisp.mail_boxes WHERE client_id = $1 AND pod_id = $2", [clientId, podId]) : null;
    if (same?.rows[0]) return boxJson(same.rows[0]);
    throw new MailError(409, "That address is taken");
  }
  return boxJson(r.rows[0]);
}

/* ---------------- Reading ---------------- */

const LIMIT_MAX = 100;
const limitOf = (q: URLSearchParams, dflt: number) => Math.max(1, Math.min(LIMIT_MAX, Number(q.get("limit")) || dflt));
/** A page token is where the next page starts (its offset). */
const offsetOf = (q: URLSearchParams) => Math.max(0, Number.parseInt(q.get("page_token") ?? "", 10) || 0);
const timeOf = (v: string | null) => (v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)) : null);

async function listMessages(box: BoxRow, q: URLSearchParams, search: string | null) {
  const limit = limitOf(q, search ? 10 : 20);
  const offset = offsetOf(q);
  const after = timeOf(q.get("after"));
  const before = timeOf(q.get("before"));
  const ascending = q.get("ascending") === "true";
  const where = ["inbox_id = $1"];
  const values: unknown[] = [box.inbox_id];
  if (after) where.push(`at > $${values.push(after)}`);
  if (before) where.push(`at < $${values.push(before)}`);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const n = values.push(like);
    where.push(
      `(subject ILIKE $${n} OR from_addr ILIKE $${n} OR text_body ILIKE $${n} OR array_to_string(to_addrs, ' ') ILIKE $${n} OR array_to_string(cc_addrs, ' ') ILIKE $${n})`,
    );
  }
  const r = await query<MsgRow>(
    `SELECT ${ITEM_COLUMNS} FROM deskwisp.mail_messages WHERE ${where.join(" AND ")} ORDER BY at ${ascending ? "ASC" : "DESC"}, message_id LIMIT ${limit + 1} OFFSET ${offset}`,
    values,
  );
  const page = r.rows.slice(0, limit);
  return {
    count: page.length,
    limit,
    next_page_token: r.rows.length > limit ? String(offset + limit) : null,
    messages: await withFiles(page, false),
  };
}

async function oneMessage(box: BoxRow, messageId: string): Promise<MsgRow> {
  const r = await query<MsgRow>(`SELECT ${MSG_COLUMNS} FROM deskwisp.mail_messages WHERE inbox_id = $1 AND message_id = $2`, [box.inbox_id, messageId]);
  if (!r.rows[0]) throw notFound("Message");
  return r.rows[0];
}

/** A thread's summary (AgentMail's ThreadItem) from its messages, oldest first. */
function threadItem(box: BoxRow, all: MsgRow[], files: Map<string, FileRow[]>) {
  const last = all[all.length - 1];
  const received = all.filter((m) => !m.labels.includes("sent"));
  const sentOnes = all.filter((m) => m.labels.includes("sent"));
  const atts = all.flatMap((m) => files.get(m.message_id) ?? []);
  return {
    inbox_id: box.inbox_id,
    thread_id: last.thread_id,
    labels: [...new Set(all.flatMap((m) => m.labels))],
    timestamp: last.at.toISOString(),
    received_timestamp: received.length ? received[received.length - 1].at.toISOString() : null,
    sent_timestamp: sentOnes.length ? sentOnes[sentOnes.length - 1].at.toISOString() : null,
    senders: [...new Set(all.map((m) => m.from_addr))],
    recipients: [...new Set(all.flatMap((m) => [...m.to_addrs, ...m.cc_addrs]))],
    subject: all[0].subject,
    preview: last.preview,
    attachments: atts.length ? atts.map(fileJson) : null,
    last_message_id: last.message_id,
    message_count: all.length,
    size: all.reduce((n, m) => n + m.size, 0),
    created_at: all[0].created_at.toISOString(),
    updated_at: last.updated_at.toISOString(),
  };
}

async function thread(box: BoxRow, threadId: string, upTo = 100) {
  const r = await query<MsgRow>(`SELECT ${MSG_COLUMNS} FROM deskwisp.mail_messages WHERE inbox_id = $1 AND thread_id = $2 ORDER BY at, message_id LIMIT ${upTo}`, [
    box.inbox_id,
    threadId,
  ]);
  if (!r.rows.length) throw notFound("Thread");
  const files = await filesOf(
    box.inbox_id,
    r.rows.map((m) => m.message_id),
  );
  return { all: r.rows, files };
}

async function attachment(box: BoxRow, messageId: string, attachmentId: string) {
  const r = await query<FileRow & { data: Buffer | null }>(
    "SELECT attachment_id, message_id, filename, content_type, disposition, content_id, size, data FROM deskwisp.mail_files WHERE inbox_id = $1 AND message_id = $2 AND attachment_id = $3",
    [box.inbox_id, messageId, attachmentId],
  );
  const f = r.rows[0];
  if (!f) throw notFound("Attachment");
  if (!f.data) throw new MailError(410, "This attachment is no longer kept", "GoneError");
  // Its bytes in the answer itself (a data: address the app's fetch reads): no second address to sign or reach.
  return {
    ...fileJson(f),
    download_url: `data:${(f.content_type || "application/octet-stream").replace(/[^\w.+/-]/g, "")};base64,${f.data.toString("base64")}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

/* ---------------- Sending (Resend) ---------------- */

type Outgoing = {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  refs: string[];
  threadId: string | null;
};

const addressList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x) => String(x).trim()).filter(Boolean);
const quoteName = (n: string) => `"${n.replace(/["\\\r\n]/g, "")}"`;
const RECIPIENTS_MAX = 50;

async function resend(body: Record<string, unknown>, idempotency: string): Promise<string> {
  const key = config.resendKey();
  if (!key) throw new MailError(503, "Sending isn't set up here (RESEND_API_KEY)", "ServiceUnavailableError");
  let res: Response;
  try {
    res = await fetch(`${config.upstream.resend()}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": idempotency,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MailError(502, "Resend couldn't be reached", "ServiceUnavailableError");
  }
  const j = (await res.json().catch(() => ({}))) as {
    id?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (!res.ok || typeof j.id !== "string") {
    const said = typeof j.message === "string" ? j.message.slice(0, 300) : `it answered ${res.status}`;
    // Its daily or monthly limit (429) and what it refuses (4xx) are the caller's to show; anything else is Resend's trouble.
    throw new MailError(res.status === 429 || (res.status >= 400 && res.status < 500) ? res.status : 502, `Resend didn't send it: ${said}`);
  }
  return j.id;
}

async function send(box: BoxRow, o: Outgoing): Promise<{ message_id: string; thread_id: string }> {
  const all = [...o.to, ...o.cc, ...o.bcc];
  if (!o.to.length) throw new MailError(400, "Who is it to? (to)");
  const bad = all.filter((x) => !ADDRESS.test(bare(x)));
  if (bad.length) throw new MailError(400, `Not an address: ${bad.slice(0, 3).join(", ")}`);
  if (all.length > RECIPIENTS_MAX) throw new MailError(400, `${RECIPIENTS_MAX} recipients at most`);
  if (!o.text?.trim() && !o.html?.trim()) throw new MailError(400, "The email is empty");
  const domain = box.inbox_id.slice(box.inbox_id.indexOf("@") + 1);
  const messageId = id("msg");
  const rfcId = `<${messageId}@${domain}>`;
  const from = box.display_name ? `${quoteName(box.display_name)} <${box.inbox_id}>` : box.inbox_id;
  const headers: Record<string, string> = {
    "Message-ID": rfcId,
    ...(o.inReplyTo ? { "In-Reply-To": o.inReplyTo } : {}),
    ...(o.refs.length ? { References: o.refs.join(" ") } : {}),
  };
  const body = {
    from,
    to: o.to,
    ...(o.cc.length ? { cc: o.cc } : {}),
    ...(o.bcc.length ? { bcc: o.bcc } : {}),
    ...(o.replyTo.length ? { reply_to: o.replyTo } : {}),
    subject: o.subject,
    ...(o.text ? { text: o.text } : {}),
    ...(o.html ? { html: o.html } : {}),
    headers,
  };
  await resend(body, messageId).catch(async (e: MailError) => {
    // A Resend that won't take a Message-ID of ours: its own then (replies thread by subject instead, see threadFor).
    if (e.status !== 422 || !/message-id|header/i.test(e.message)) throw e;
    const { "Message-ID": _mine, ...rest } = headers;
    void _mine;
    return resend({ ...body, headers: rest }, `${messageId}-2`);
  });
  const threadId = o.threadId ?? id("thr");
  const text = o.text ?? (o.html ? htmlText(o.html) : "");
  await query(
    `INSERT INTO deskwisp.mail_messages (inbox_id, message_id, thread_id, labels, from_addr, to_addrs, cc_addrs, reply_to, subject, preview, text_body, html_body, rfc_id, in_reply_to, refs, size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      box.inbox_id,
      messageId,
      threadId,
      ["sent"],
      from,
      o.to,
      o.cc,
      o.replyTo,
      o.subject,
      previewOf(text),
      text || null,
      o.html,
      rfcId,
      o.inReplyTo,
      o.refs,
      Buffer.byteLength(`${text}${o.html ?? ""}`),
    ],
  );
  return { message_id: messageId, thread_id: threadId };
}

type SendBody = {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  reply_all?: unknown;
};
const str = (v: unknown) => (typeof v === "string" ? v : null);

async function sendNew(box: BoxRow, b: SendBody) {
  return send(box, {
    to: addressList(b.to),
    cc: addressList(b.cc),
    bcc: addressList(b.bcc),
    replyTo: addressList(b.reply_to),
    subject: (str(b.subject) ?? "").slice(0, 500),
    text: str(b.text),
    html: str(b.html),
    inReplyTo: null,
    refs: [],
    threadId: null,
  });
}

/** A reply in the same conversation: to who wrote it (or, to what a bot sent, the same people again), "Re:" and threaded. */
async function sendReply(box: BoxRow, messageId: string, b: SendBody, all: boolean) {
  const m = await oneMessage(box, messageId);
  const me = box.inbox_id;
  const notMe = (x: string) => bare(x) !== me;
  const sentByMe = m.labels.includes("sent");
  const back = sentByMe ? m.to_addrs : m.reply_to.length ? m.reply_to : [m.from_addr];
  const given = addressList(b.to);
  const to = given.length ? given : all && !sentByMe ? [...back, ...m.to_addrs.filter(notMe)] : back;
  const cc = addressList(b.cc).length ? addressList(b.cc) : all ? m.cc_addrs.filter(notMe) : [];
  const subject = /^re:/i.test(m.subject ?? "") ? (m.subject ?? "") : `Re: ${m.subject ?? ""}`.trim();
  return send(box, {
    to: [...new Map(to.map((x) => [bare(x), x])).values()],
    cc: [...new Map(cc.map((x) => [bare(x), x])).values()].filter((x) => !to.some((t) => bare(t) === bare(x))),
    bcc: addressList(b.bcc),
    replyTo: addressList(b.reply_to),
    subject,
    text: str(b.text),
    html: str(b.html),
    inReplyTo: m.rfc_id,
    refs: [...m.refs, ...(m.rfc_id ? [m.rfc_id] : [])].slice(-20),
    threadId: m.thread_id,
  });
}

/* ---------------- The API, as AgentMail's ---------------- */

type Answer = [status: number, body: unknown];

/**
 * One call, as AgentMail would answer it. `path` starts at /v0. The cloud calls this in-process
 * (session.ts agentmail(), as the master); the app reaches it over HTTP with its pod's key.
 */
export async function mailApi(who: MailCaller, method: string, pathAndQuery: string, body: unknown = {}): Promise<Answer> {
  const url = new URL(pathAndQuery, "http://mail");
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  const q = url.searchParams;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const at = (...want: string[]) => parts.length === want.length && want.every((w, i) => w === "*" || w === parts[i]);
  if (parts[0] !== "v0") throw notFound("Route");

  if (method === "POST" && at("v0", "pods")) {
    onlyMaster(who);
    return [200, await makePod(b)];
  }
  if (method === "GET" && at("v0", "pods")) {
    onlyMaster(who);
    const limit = limitOf(q, 20);
    const offset = offsetOf(q);
    const r = await query<PodRow>(`SELECT * FROM deskwisp.mail_pods ORDER BY created_at, pod_id LIMIT ${limit + 1} OFFSET ${offset}`);
    const page = r.rows.slice(0, limit);
    return [
      200,
      {
        count: page.length,
        limit,
        next_page_token: r.rows.length > limit ? String(offset + limit) : null,
        pods: page.map(podJson),
      },
    ];
  }
  if (method === "POST" && at("v0", "pods", "*", "api-keys")) {
    onlyMaster(who);
    const pod = await query("SELECT 1 FROM deskwisp.mail_pods WHERE pod_id = $1", [parts[2]]);
    if (!pod.rowCount) throw notFound("Pod");
    const key = `dwm_${randomBytes(32).toString("base64url")}`;
    const keyId = id("key");
    await query("INSERT INTO deskwisp.mail_keys (key_hash, pod_id, name) VALUES ($1, $2, $3)", [sha256(key), parts[2], (str(b.name) ?? "").slice(0, 200) || null]);
    return [
      200,
      {
        api_key_id: keyId,
        api_key: key,
        name: str(b.name),
        pod_id: parts[2],
        created_at: new Date().toISOString(),
      },
    ];
  }
  if (method === "POST" && at("v0", "pods", "*", "inboxes")) return [200, await makeBox(who, parts[2], b)];
  if (at("v0", "pods", "*", "inboxes", "*")) {
    podReach(who, parts[2]);
    const box = await boxFor({ podId: parts[2] }, parts[4]);
    if (method === "GET") return [200, boxJson(box)];
    if (method === "DELETE") {
      await query("DELETE FROM deskwisp.mail_boxes WHERE inbox_id = $1", [box.inbox_id]);
      return [204, null];
    }
  }

  if (parts[1] === "inboxes" && parts[2]) {
    const box = await boxFor(who, parts[2]);
    if (method === "GET" && at("v0", "inboxes", "*", "messages")) return [200, await listMessages(box, q, null)];
    if (method === "GET" && at("v0", "inboxes", "*", "messages", "search")) {
      const term = (q.get("q") ?? "").trim().slice(0, 200);
      return [200, await listMessages(box, q, term || null)];
    }
    if (method === "POST" && at("v0", "inboxes", "*", "messages", "send")) return [200, await sendNew(box, b)];
    if (method === "GET" && at("v0", "inboxes", "*", "messages", "*")) {
      const m = await oneMessage(box, parts[4]);
      return [200, (await withFiles([m], true))[0]];
    }
    if (method === "POST" && at("v0", "inboxes", "*", "messages", "*", "reply")) return [200, await sendReply(box, parts[4], b, b.reply_all === true)];
    if (method === "POST" && at("v0", "inboxes", "*", "messages", "*", "reply-all")) return [200, await sendReply(box, parts[4], b, true)];
    if (method === "GET" && at("v0", "inboxes", "*", "messages", "*", "attachments", "*")) return [200, await attachment(box, parts[4], parts[6])];
    if (method === "GET" && at("v0", "inboxes", "*", "threads", "*")) {
      const { all, files } = await thread(box, parts[4]);
      const messages = all.map((m) => messageJson(m, files.get(m.message_id) ?? [], true));
      return [
        200,
        {
          ...threadItem(box, all, files),
          count: messages.length,
          limit: null,
          next_page_token: null,
          messages,
        },
      ];
    }
  }
  throw notFound("Route");
}

/* ---------------- Mail coming in (Cloudflare → the Worker → here) ---------------- */

/** How old an inbound post may be (its signed time), against replays. */
const INBOUND_TOLERANCE_S = 5 * 60;
/** An email's bytes kept per attachment, and per email: bigger ones are named and sized only. */
const FILE_KEEP_MAX = 5 * 1024 * 1024;
const MESSAGE_KEEP_MAX = 12 * 1024 * 1024;

/** The Worker's signature: hex HMAC-SHA256 over "<time>\n<to>\n<from>\n" and the raw email, keyed with DESKWISP_MAIL_INBOUND_SECRET. */
export function inboundSignature(secret: string, time: string, to: string, from: string, raw: Buffer) {
  return createHmac("sha256", secret).update(`${time}\n${to}\n${from}\n`).update(raw).digest("hex");
}

function signedRight(secret: string, req: IncomingMessage, raw: Buffer, now = Date.now()) {
  const one = (h: string) => {
    const v = req.headers[h];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const time = one("x-deskwisp-mail-time");
  const sig = one("x-deskwisp-mail-signature");
  if (!/^\d+$/.test(time) || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(now / 1000 - Number(time)) > INBOUND_TOLERANCE_S) return false;
  const want = Buffer.from(inboundSignature(secret, time, one("x-deskwisp-mail-to"), one("x-deskwisp-mail-from"), raw), "hex");
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

const addressText = (a: Address) =>
  "group" in a && a.group ? a.group.map((m) => (m.name ? `${m.name} <${m.address}>` : m.address)) : a.address ? [a.name ? `${a.name} <${a.address}>` : a.address] : [];
const addressesOf = (xs: Address[] | undefined) => (xs ?? []).flatMap(addressText).slice(0, 100);

/** Headers kept with an email (first of each, cut short): the ones bots and the app read. Authentication results are the cloud's own verdict instead. */
function headerMap(email: Email) {
  const out: Record<string, string> = {};
  for (const h of email.headers) {
    if (Object.keys(out).length >= 60) break;
    if (/^(arc-|authentication-results$|dkim-signature$|received$|x-received$|received-spf$)/.test(h.key)) continue;
    const name = h.originalKey || h.key;
    if (!(name in out)) out[name] = h.value.slice(0, 2000);
  }
  return out;
}

/**
 * Whether DMARC passed for the sender's domain, as the receiving side (Cloudflare) found it: only an
 * Authentication-Results (or ARC-Authentication-Results) above the first Received header counts.
 * Anything below it was in the email as it arrived, and anyone can write that. "pass", "fail" or "none".
 */
export function dmarcOf(email: Email, fromAddress: string): "pass" | "fail" | "none" {
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
  const firstReceived = email.headers.findIndex((h) => h.key === "received");
  if (firstReceived < 0 || !domain) return "none";
  const ours = email.headers.slice(0, firstReceived).filter((h) => h.key === "authentication-results" || h.key === "arc-authentication-results");
  let verdict: "pass" | "fail" | "none" = "none";
  for (const h of ours) {
    let v = h.value.replace(/\r?\n[ \t]+/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (let i = 0; i < 4 && v.includes("("); i++) v = v.replace(/\([^()]*\)/g, " ");
    for (const part of v.split(/[;,]/)) {
      const m = /^\s*dmarc\s*=\s*([a-z]+)([\s\S]*)$/i.exec(part);
      if (!m) continue;
      const from = /(?:^|\s)header\.from\s*=\s*(\S+)/i.exec(m[2])?.[1]?.toLowerCase();
      if (from && from !== domain) continue;
      if (m[1].toLowerCase() === "fail") return "fail";
      if (m[1].toLowerCase() === "pass" && from === domain) verdict = "pass";
    }
  }
  return verdict;
}

const ids = (s: string | undefined) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];
const plainSubject = (s: string | null | undefined) =>
  (s ?? "")
    .replace(/^\s*((re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();

/**
 * The conversation an email belongs to: the one an email it answers is in (In-Reply-To, References),
 * else, for an answer to a bot's email whose Message-ID Resend replaced, the latest one with the same
 * subject that this sender was part of (90 days), else a new one.
 */
async function threadFor(inboxId: string, refs: string[], subject: string | null, sender: string): Promise<string> {
  if (refs.length) {
    const r = await query<{ thread_id: string }>("SELECT thread_id FROM deskwisp.mail_messages WHERE inbox_id = $1 AND rfc_id = ANY($2::text[]) ORDER BY at DESC LIMIT 1", [
      inboxId,
      refs,
    ]);
    if (r.rows[0]) return r.rows[0].thread_id;
  }
  const plain = plainSubject(subject);
  if (plain && /^\s*(re|aw|sv|antw)\s*:/i.test(subject ?? "")) {
    const r = await query<{ thread_id: string; subject: string | null }>(
      `SELECT thread_id, subject FROM deskwisp.mail_messages
       WHERE inbox_id = $1 AND at > now() - interval '90 days' AND ($2 = lower(from_addr) OR lower(from_addr) LIKE $3 OR $2 = ANY(SELECT lower(x) FROM unnest(to_addrs || cc_addrs) x) OR EXISTS (SELECT 1 FROM unnest(to_addrs || cc_addrs) x WHERE lower(x) LIKE $3))
       ORDER BY at DESC LIMIT 50`,
      [inboxId, sender, `%<${sender.replace(/[\\%_]/g, (c) => `\\${c}`)}>`],
    );
    const hit = r.rows.find((x) => plainSubject(x.subject) === plain);
    if (hit) return hit.thread_id;
  }
  return id("thr");
}

/** A Worker's post: the email stored in its inbox, and the app told (its WebSocket). Null when no inbox has that address. */
export async function receiveRaw(envelopeTo: string, raw: Buffer): Promise<{ inboxId: string; messageId: string; duplicate: boolean } | null> {
  const inboxId = untagged(bare(envelopeTo));
  const box = (await query<BoxRow>("SELECT * FROM deskwisp.mail_boxes WHERE inbox_id = $1", [inboxId])).rows[0];
  if (!box) return null;
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
  });
  const rfcId = email.messageId?.trim() || null;
  if (rfcId) {
    const had = await query<{ message_id: string }>("SELECT message_id FROM deskwisp.mail_messages WHERE inbox_id = $1 AND rfc_id = $2 AND NOT ('sent' = ANY(labels))", [
      box.inbox_id,
      rfcId,
    ]);
    if (had.rows[0])
      return {
        inboxId: box.inbox_id,
        messageId: had.rows[0].message_id,
        duplicate: true,
      };
  }
  const fromList = email.from ? addressText(email.from) : [];
  const from = fromList[0] ?? "unknown@invalid";
  const sender = bare(from);
  const inReplyTo = ids(email.inReplyTo)[0] ?? null;
  const refs = [...new Set([...ids(email.references), ...(inReplyTo ? [inReplyTo] : [])])].slice(-30);
  const subject = email.subject?.slice(0, 1000) ?? null;
  const html = email.html ?? null;
  const text = email.text?.trim() ? email.text : html ? htmlText(html) : "";
  const threadId = await threadFor(box.inbox_id, refs, subject, sender);
  const messageId = id("msg");
  // The time it came, not the time it says it was written (a sender's clock can say anything).
  const at = new Date();
  let kept = 0;
  const files = email.attachments.map((a) => {
    const bytes = Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : typeof a.content === "string" ? Buffer.from(a.content) : a.content);
    const keep = bytes.length <= FILE_KEEP_MAX && kept + bytes.length <= MESSAGE_KEEP_MAX;
    if (keep) kept += bytes.length;
    return { a, bytes, keep };
  });
  const row = await tx(async (c) => {
    const r = await c.query<MsgRow>(
      `INSERT INTO deskwisp.mail_messages (inbox_id, message_id, thread_id, labels, at, from_addr, to_addrs, cc_addrs, reply_to, subject, preview, text_body, html_body, rfc_id, in_reply_to, refs, headers, dmarc, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${MSG_COLUMNS}`,
      [
        box.inbox_id,
        messageId,
        threadId,
        ["received", "unread"],
        at,
        from,
        addressesOf(email.to),
        addressesOf(email.cc),
        addressesOf(email.replyTo),
        subject,
        previewOf(text),
        text ? text.slice(0, 500_000) : null,
        html ? html.slice(0, 2_000_000) : null,
        rfcId,
        inReplyTo,
        refs,
        JSON.stringify(headerMap(email)),
        dmarcOf(email, sender),
        raw.length,
      ],
    );
    for (const f of files) {
      await c.query(
        "INSERT INTO deskwisp.mail_files (attachment_id, inbox_id, message_id, filename, content_type, disposition, content_id, size, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          id("att"),
          box.inbox_id,
          messageId,
          f.a.filename?.slice(0, 300) ?? null,
          f.a.mimeType?.slice(0, 200) ?? null,
          f.a.disposition,
          f.a.contentId?.slice(0, 300) ?? null,
          f.bytes.length,
          f.keep ? f.bytes : null,
        ],
      );
    }
    return r.rows[0];
  });
  void tell(box, row).catch((e: Error) => console.warn(`[mail] couldn't tell the app about ${messageId}: ${e.message}`));
  return { inboxId: box.inbox_id, messageId, duplicate: false };
}

/* ---------------- The app's WebSocket (as AgentMail's) ---------------- */

type Listener = {
  ws: WebSocket;
  podId: string;
  pods: Set<string>;
  inboxes: Set<string>;
  events: Set<string> | null;
};
const listeners = new Set<Listener>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/** A new email, to every socket of its pod that subscribed to it. */
async function tell(box: BoxRow, row: MsgRow) {
  const want = [...listeners].filter((l) => l.podId === box.pod_id && (l.pods.has(box.pod_id) || l.inboxes.has(box.inbox_id)) && (!l.events || l.events.has("message.received")));
  if (!want.length) return;
  const files = await filesOf(box.inbox_id, [row.message_id]);
  const { all, files: threadFiles } = await thread(box, row.thread_id);
  const event = JSON.stringify({
    type: "event",
    event_type: "message.received",
    event_id: id("evt"),
    message: messageJson(row, files.get(row.message_id) ?? [], true),
    thread: threadItem(box, all, threadFiles),
  });
  for (const l of want) if (l.ws.readyState === l.ws.OPEN) l.ws.send(event);
}

function listen(ws: WebSocket, podId: string) {
  const l: Listener = {
    ws,
    podId,
    pods: new Set(),
    inboxes: new Set(),
    events: null,
  };
  listeners.add(l);
  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  ping.unref();
  ws.on("message", (data) => {
    let m: {
      type?: unknown;
      pod_ids?: unknown;
      inbox_ids?: unknown;
      event_types?: unknown;
    };
    try {
      m = JSON.parse(String(data));
    } catch {
      return ws.send(
        JSON.stringify({
          type: "error",
          name: "ValidationError",
          message: "Not JSON",
        }),
      );
    }
    if (m.type !== "subscribe")
      return ws.send(
        JSON.stringify({
          type: "error",
          name: "ValidationError",
          message: "Only subscribe is understood here",
        }),
      );
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    // Its own pod only, whatever else it names.
    for (const p of list(m.pod_ids)) if (p === podId) l.pods.add(p);
    void (async () => {
      const named = list(m.inbox_ids).map((x) => x.toLowerCase());
      if (named.length) {
        const r = await query<{ inbox_id: string }>("SELECT inbox_id FROM deskwisp.mail_boxes WHERE pod_id = $1 AND inbox_id = ANY($2::text[])", [podId, named]);
        for (const x of r.rows) l.inboxes.add(x.inbox_id);
      }
      const events = list(m.event_types);
      l.events = events.length ? new Set(events) : null;
      ws.send(
        JSON.stringify({
          type: "subscribed",
          pod_ids: [...l.pods],
          inbox_ids: [...l.inboxes],
          event_types: events.length ? events : null,
        }),
      );
    })().catch(() => ws.close(1011));
  });
  ws.on("close", () => {
    clearInterval(ping);
    listeners.delete(l);
  });
  ws.on("error", () => ws.terminate());
}

/** Open sockets (for tests and /health-like checks). */
export const mailListeners = () => listeners.size;

/* ---------------- HTTP ---------------- */

async function answer(res: ServerResponse, a: Answer) {
  if (a[0] === 204) {
    res.writeHead(204, { "cache-control": "no-store" });
    return void res.end();
  }
  sendJson(res, a[0], a[1]);
}

const apiRoute = (method: string): Route => ({
  method,
  path: "/mail/v0/*",
  auth: "public",
  handle: async (req, res, { url }) => {
    if (!config.ownMail())
      return sendJson(res, 404, {
        name: "NotFoundError",
        message: "Mail isn't run here",
      });
    const key = keyOf(req, url);
    const podId = key ? await podOfKey(key) : null;
    if (!podId)
      return sendJson(res, 401, {
        name: "UnauthorizedError",
        message: "That key isn't one of this cloud's",
      });
    let body: unknown = {};
    if (method === "POST" || method === "PATCH") {
      const raw = await readBody(req, 8 * 1024 * 1024);
      try {
        body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return sendJson(res, 400, {
          name: "ValidationError",
          message: "Body isn't JSON",
        });
      }
    }
    try {
      await answer(res, await mailApi({ podId }, method, `${url.pathname.slice("/mail".length)}${url.search}`, body));
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
      sendJson(res, e.status, { name: e.name, message: e.message });
    }
  },
});

export const routes: Route[] = [
  apiRoute("GET"),
  apiRoute("POST"),
  apiRoute("DELETE"),
  {
    method: "POST",
    path: "/mail/inbound",
    auth: "public",
    handle: async (req, res) => {
      const secret = config.mailInboundSecret();
      // Not set up (yet): a failure the sender's server tries again later, never a bounce.
      if (!config.ownMail() || !secret) throw new HttpError(503, "Deskwisp Mail isn't set up on this cloud");
      const raw = await readBody(req, 26 * 1024 * 1024);
      if (!signedRight(secret, req, raw)) throw new HttpError(401, "Not signed by this cloud's Worker");
      const to = String(req.headers["x-deskwisp-mail-to"] ?? "");
      const got = await receiveRaw(to, raw);
      // The Worker turns the email down (the sender gets a bounce) when nobody here has the address.
      if (!got) return sendJson(res, 404, { error: "No inbox has that address" });
      sendJson(res, 200, {
        ok: true,
        message_id: got.messageId,
        duplicate: got.duplicate,
      });
    },
  },
];

export const upgrades: Upgrade[] = [
  {
    path: "/mail/v0",
    auth: "public",
    handle: (req, socket, head, { url }) => {
      void (async () => {
        const key = keyOf(req, url);
        const podId = config.ownMail() && key ? await podOfKey(key) : null;
        if (!podId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return void socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => listen(ws, podId));
      })().catch(() => socket.destroy());
    },
  },
];

/* ---------------- Keeping it small ---------------- */

/** How long attachments' bytes are kept (their names and sizes stay). */
export const FILES_KEPT_DAYS = 30;

/** Old attachments' bytes go (every 6 hours): the database stays small. */
export function startMailSweeps() {
  if (!config.ownMail()) return () => {};
  const sweep = () =>
    void query(`UPDATE deskwisp.mail_files SET data = NULL WHERE data IS NOT NULL AND created_at < now() - interval '${FILES_KEPT_DAYS} days'`).catch((e: Error) =>
      console.warn(`[mail] sweep: ${e.message}`),
    );
  sweep();
  const t = setInterval(sweep, 6 * 3600_000);
  t.unref();
  return () => clearInterval(t);
}

/** Whether Deskwisp Mail has this pod (session.ts: a pod kept from AgentMail isn't one). */
export async function mailPodThere(podId: string) {
  return !!(await query("SELECT 1 FROM deskwisp.mail_pods WHERE pod_id = $1", [podId])).rowCount;
}

/** Whether a key is this pod's. */
export async function mailKeyFits(key: string, podId: string) {
  return (await podOfKey(key)) === podId;
}

/** For tests: forget remembered keys. */
export const forgetMailKeys = () => keys.clear();
