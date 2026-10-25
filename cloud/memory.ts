import { randomBytes } from "node:crypto";
import { ensureUserRow, query } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";

/**
 * Deskwisp's own long-term memory, kept here (deskwisp.memory_facts and memory_cards, db/migrations/0017)
 * where Honcho isn't used, so every place the user's bots answer from knows them: the PC app
 * (lib/server/memory.ts, through lib/server/local-memory.ts's cloud store), this cloud's own answers
 * when the PC is away (agent.ts, through honcho.ts memoryBlock), and the phone app. Free: Postgres
 * only; what needs a model (answering a question about the user, writing the card from the facts) is
 * done by the app, on the user's AI credit.
 *
 * - A user has banks (a Deskwisp workspace's memory, or one several share), named as the app names
 *   them ("deskwisp", "deskwisp-ws_x"). Only their own: every query is by their user id.
 * - Facts: what's been learned about the user, newest first, with the chat or task each came from.
 *   At most MAX_FACTS a bank (the oldest go) and 1000 characters each.
 * - Search by words, rarer words counting for more (search below; lib/server/local-memory.ts has the same).
 * - The card: the short list read first, and the lines the user put in by hand (pinned).
 */

const MAX_FACTS = 5000;
const BANK = /^[A-Za-z0-9_-]{1,120}$/;

type Row = { id: string; content: string; session_id: string | null; level: string; created_at: Date };
export type Fact = { id: string; content: string; sessionId: string | null; createdAt: string; level: string };
const out = (r: Row): Fact => ({ id: r.id, content: r.content, sessionId: r.session_id, createdAt: r.created_at.toISOString(), level: r.level });

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when where which who will with you your about into than then there these those do does did not no yes can could would should".split(" "),
);
const words = (t: string) => (t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The facts closest to `q`, best first: each word of the question that's in a fact counts, rarer words more. */
export function search<F extends { content: string; createdAt: string }>(facts: F[], q: string, k: number): F[] {
  const qw = [...new Set(words(q))];
  if (!qw.length) return [];
  const sets = facts.map((f) => new Set(words(f.content)));
  const near = (s: Set<string>, w: string) => (s.has(w) ? 1 : [...s].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))) ? 0.6 : 0);
  const df = new Map<string, number>();
  for (const s of sets) for (const w of qw) if (near(s, w)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = facts.length || 1;
  return facts
    .map((f, i) => ({ f, score: qw.reduce((sum, w) => sum + near(sets[i], w) * Math.log(1 + n / (df.get(w) ?? 1)), 0) / Math.sqrt(Math.max(4, sets[i].size)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.f.createdAt) - Date.parse(a.f.createdAt))
    .slice(0, k)
    .map((x) => x.f);
}

const bankOf = (raw: string | undefined) => {
  const b = decodeURIComponent(raw ?? "");
  if (!BANK.test(b)) throw new HttpError(400, "No such memory.");
  return b;
};
const strings = (x: unknown, max: number) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").map((s) => s.trim().slice(0, 1000)).filter(Boolean).slice(0, max) : []);

/** A bank's newest facts (up to `limit`). */
export async function facts(userId: string, bank: string, limit = MAX_FACTS, offset = 0, sessions?: string[]) {
  const r = await query<Row>(
    `SELECT id, content, session_id, level, created_at FROM deskwisp.memory_facts
     WHERE user_id = $1 AND bank = $2 ${sessions ? "AND session_id = ANY($5)" : ""}
     ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    sessions ? [userId, bank, limit, offset, sessions] : [userId, bank, limit, offset],
  );
  return r.rows.map(out);
}

/** A bank's card: its lines, and those the user put in by hand. */
export async function card(userId: string, bank: string) {
  const r = await query<{ lines: unknown; pinned: unknown }>("SELECT lines, pinned FROM deskwisp.memory_cards WHERE user_id = $1 AND bank = $2", [userId, bank]);
  return { lines: strings(r.rows[0]?.lines, 40), pinned: strings(r.rows[0]?.pinned, 40) };
}

/** The facts closest to `q` in a bank. */
export const searchFacts = async (userId: string, bank: string, q: string, k: number) => search(await facts(userId, bank), q, k);

/**
 * /v1/memory/<bank>…: a route per method that reads which bank and what from the path.
 *   GET  /v1/memory/<bank>                 the card (lines, pinned) and how many facts there are
 *   PUT  /v1/memory/<bank>/card            { lines, pinned }
 *   GET  /v1/memory/<bank>/facts           newest first: ?size= (200 at most) &offset= &sessions=a,b
 *   GET  /v1/memory/<bank>/search          ?q= &k=
 *   POST /v1/memory/<bank>/facts           { items: [{ content, sessionId? }] }: new facts (the oldest go past MAX_FACTS)
 *   POST /v1/memory/<bank>/facts/get       { ids }
 *   POST /v1/memory/<bank>/facts/delete    { ids }
 */
function where(url: URL) {
  const m = /^\/v1\/memory\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) throw new HttpError(404, "not found");
  return { bank: bankOf(m[1]), rest: m[2] ?? "" };
}
const num = (url: URL, name: string, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, Number(url.searchParams.get(name)) || fallback));
const count = async (userId: string, bank: string, sessions?: string[]) =>
  Number(
    (await query<{ n: string }>(`SELECT count(*) AS n FROM deskwisp.memory_facts WHERE user_id = $1 AND bank = $2 ${sessions ? "AND session_id = ANY($3)" : ""}`, sessions ? [userId, bank, sessions] : [userId, bank])).rows[0]?.n ?? 0,
  );

export const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/memory/*",
    auth: "user",
    handle: async (_req, res, { user, url }) => {
      const { bank, rest } = where(url);
      const me = user!.id;
      if (rest === "") return sendJson(res, 200, { ...(await card(me, bank)), total: await count(me, bank) });
      if (rest === "/facts") {
        const sessions = url.searchParams.get("sessions")?.split(",").filter(Boolean).slice(0, 400);
        const [items, total] = await Promise.all([facts(me, bank, num(url, "size", 100, 1, 200), num(url, "offset", 0, 0, 1e9), sessions), count(me, bank, sessions)]);
        return sendJson(res, 200, { items, total });
      }
      if (rest === "/search") return sendJson(res, 200, { items: await searchFacts(me, bank, (url.searchParams.get("q") ?? "").slice(0, 1000), num(url, "k", 10, 1, 100)) });
      throw new HttpError(404, "not found");
    },
  },
  {
    method: "PUT",
    path: "/v1/memory/*",
    auth: "user",
    handle: async (req, res, { user, url }) => {
      const { bank, rest } = where(url);
      if (rest !== "/card") throw new HttpError(404, "not found");
      const b = await readJson<{ lines?: unknown; pinned?: unknown }>(req);
      const lines = strings(b.lines, 40).map((l) => l.slice(0, 300));
      const pinned = strings(b.pinned, 40).filter((l) => lines.includes(l));
      await ensureUserRow(user!.id);
      await query(
        `INSERT INTO deskwisp.memory_cards (user_id, bank, lines, pinned) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, bank) DO UPDATE SET lines = EXCLUDED.lines, pinned = EXCLUDED.pinned, updated_at = now()`,
        [user!.id, bank, JSON.stringify(lines), JSON.stringify(pinned)],
      );
      sendJson(res, 200, { lines, pinned });
    },
  },
  {
    method: "POST",
    path: "/v1/memory/*",
    auth: "user",
    handle: async (req, res, { user, url }) => {
      const { bank, rest } = where(url);
      const me = user!.id;
      if (rest === "/facts") {
        const b = await readJson<{ items?: { content?: unknown; sessionId?: unknown }[] }>(req, 2 * 1024 * 1024);
        const items = (Array.isArray(b.items) ? b.items : [])
          .map((i) => ({ content: typeof i?.content === "string" ? i.content.trim().slice(0, 1000) : "", sessionId: typeof i?.sessionId === "string" ? i.sessionId.slice(0, 200) : null }))
          .filter((i) => i.content)
          .slice(0, 200);
        if (!items.length) return sendJson(res, 200, { items: [] });
        await ensureUserRow(me);
        const made: Fact[] = [];
        for (const i of items) {
          const id = `mf_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
          const r = await query<Row>(
            "INSERT INTO deskwisp.memory_facts (id, user_id, bank, content, session_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, content, session_id, level, created_at",
            [id, me, bank, i.content, i.sessionId],
          );
          made.push(out(r.rows[0]));
        }
        await query(
          `DELETE FROM deskwisp.memory_facts WHERE user_id = $1 AND bank = $2 AND id IN (
             SELECT id FROM deskwisp.memory_facts WHERE user_id = $1 AND bank = $2 ORDER BY created_at DESC, id DESC OFFSET $3)`,
          [me, bank, MAX_FACTS],
        );
        return sendJson(res, 200, { items: made });
      }
      if (rest === "/facts/get" || rest === "/facts/delete") {
        const ids = strings((await readJson<{ ids?: unknown }>(req)).ids, 500);
        if (rest === "/facts/get") {
          const r = await query<Row>("SELECT id, content, session_id, level, created_at FROM deskwisp.memory_facts WHERE user_id = $1 AND bank = $2 AND id = ANY($3)", [me, bank, ids]);
          return sendJson(res, 200, { items: r.rows.map(out) });
        }
        const r = await query("DELETE FROM deskwisp.memory_facts WHERE user_id = $1 AND bank = $2 AND id = ANY($3)", [me, bank, ids]);
        return sendJson(res, 200, { deleted: r.rowCount ?? 0 });
      }
      throw new HttpError(404, "not found");
    },
  },
];
