import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openaiClient } from "./openai-client";
import { ownerName } from "./store";
import { recordTokens, usageTags } from "./usage";

/**
 * Memory without Honcho: the same memory (the user's card, the facts learned about them, search,
 * questions, tidying up), kept in a file on this PC for each bank (<user folder>/memory/<bank>.json),
 * at no cost beyond a model call now and then. lib/server/memory.ts uses it when Deskwisp Cloud has no
 * Honcho for the user (and there's no HONCHO_API_KEY): the bots remember either way.
 *
 * It answers the part of Honcho's SDK memory.ts uses (a client, its peers and sessions, and their
 * conclusions), so the rest of memory.ts is the same for both:
 * - Facts ("conclusions") come from what memory.ts saves: what the user says that's worth keeping
 *   (rememberMessage), what a bot remembers, what's pinned or copied. Each has its source (the chat or
 *   task it came from, when there's one).
 * - Search is by words, weighed by how rare each word is among the facts (a name counts for more than
 *   "the"), any language, newest first among equals.
 * - A question ("what's their shipping address?") is answered by a model from the closest facts and the card.
 * - The card is written from the facts by a model ("dreaming"): when asked, and by itself once a few
 *   new facts came in. Lines the user pinned stay.
 * - What was said isn't kept here (Honcho reads conversations; here only the facts are kept).
 */

type Fact = { id: string; content: string; sessionId: string | null; createdAt: string; level: string };
type Bank = { card: string[]; pinned: string[]; facts: Fact[]; sinceDream: number; dreamedAt?: string };

const MAX_FACTS = 5000;
const MODEL = process.env.DESKWISP_MEMORY_MODEL ?? process.env.DESKWISP_CHAT_MODEL ?? "gpt-6.1-sol";

const g = globalThis as unknown as { deskwispLocalMemory?: { banks: Map<string, Bank>; dreams: Map<string, ReturnType<typeof setTimeout>> } };
const live = (g.deskwispLocalMemory ??= { banks: new Map(), dreams: new Map() });

const fileOf = (dir: string, bank: string) => join(dir, "memory", `${bank.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120)}.json`);

function load(dir: string, bank: string): Bank {
  const file = fileOf(dir, bank);
  let b = live.banks.get(file);
  if (b) return b;
  b = { card: [], pinned: [], facts: [], sinceDream: 0 };
  try {
    if (existsSync(file)) b = { ...b, ...(JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Partial<Bank>) };
  } catch {}
  live.banks.set(file, b);
  return b;
}
function save(dir: string, bank: string, b: Bank) {
  const file = fileOf(dir, bank);
  mkdirSync(join(dir, "memory"), { recursive: true, mode: 0o700 });
  writeFileSync(/*turbopackIgnore: true*/ `${file}.tmp`, JSON.stringify(b), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/* ---------------- Search by words ---------------- */

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when where which who will with you your about into than then there these those do does did not no yes can could would should".split(" "),
);
const words = (t: string) => (t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The facts closest to `q`, best first: each word of the question that's in a fact counts, rarer words more. */
export function search(facts: Fact[], q: string, k: number) {
  const qw = [...new Set(words(q))];
  if (!qw.length) return [];
  const df = new Map<string, number>();
  const sets = facts.map((f) => new Set(words(f.content)));
  for (const s of sets) for (const w of qw) if (s.has(w) || [...s].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))) df.set(w, (df.get(w) ?? 0) + 1);
  const n = facts.length || 1;
  const scored = facts.map((f, i) => {
    let score = 0;
    for (const w of qw) {
      const s = sets[i];
      const hit = s.has(w) ? 1 : [...s].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))) ? 0.6 : 0;
      if (hit) score += hit * Math.log(1 + n / (df.get(w) ?? 1));
    }
    return { f, score: score / Math.sqrt(Math.max(4, sets[i].size)) };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.f.createdAt) - Date.parse(a.f.createdAt))
    .slice(0, k)
    .map((x) => x.f);
}

/* ---------------- What the SDK hands back ---------------- */

/** A page of conclusions, as the SDK's: its items, the total, the next page, and every one with for-await. */
function page(all: Fact[], size: number, at = 0) {
  const items = all.slice(at, at + size).map(out);
  const p = {
    items,
    total: all.length,
    hasNextPage: at + size < all.length,
    getNextPage: async () => (at + size < all.length ? page(all, size, at + size) : null),
    async *[Symbol.asyncIterator]() {
      for (let i = at; i < all.length; i++) yield out(all[i]);
    },
  };
  return p;
}
const out = (f: Fact) => ({ id: f.id, content: f.content, sessionId: f.sessionId, createdAt: f.createdAt, level: f.level });
const newest = (b: Bank) => [...b.facts].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

async function ask(instructions: string, input: string, effort: "low" | "medium" = "low") {
  const res = await openaiClient().responses.create({ model: MODEL, reasoning: { effort }, instructions, input }, usageTags("memory"));
  recordTokens("memory", res.model, res.usage);
  return (res.output_text ?? "").trim();
}

/**
 * The client memory.ts makes for a bank when it runs without Honcho. `dir` is the user's folder.
 * Only the owner's peer has facts; bots' peers and sessions are there so saving a conversation works.
 */
export function localMemoryClient(dir: string, bank: string) {
  const b = () => load(dir, bank);
  const keep = () => save(dir, bank, b());

  /** The card again from the facts, in the background, a little after new facts stop coming. */
  const dreamSoon = () => {
    const key = fileOf(dir, bank);
    clearTimeout(live.dreams.get(key));
    live.dreams.set(
      key,
      setTimeout(() => {
        live.dreams.delete(key);
        void dream().catch((e: Error) => console.warn(`[memory] the card: ${e.message}`));
      }, 45_000).unref?.() as ReturnType<typeof setTimeout>,
    );
  };

  async function dream() {
    const bk = b();
    const facts = newest(bk).slice(0, 400);
    if (!facts.length) return;
    const owner = ownerName();
    const text = await ask(
      `You keep ${owner}'s card: the short list their AI assistants read first about them. From the facts below, write it again: at most 25 lines, one fact per line, each a plain third-person sentence starting with "${owner}" or naming the person it's about. Put first who they are (name, what they do, company), then the people in their life and work, then how they like things done, then ongoing plans. Leave out passing details, anything a newer fact replaced, and anything private (addresses, phone numbers, account numbers, passwords, health). No headings, no bullets.`,
      facts.map((f) => `- ${f.content}`).join("\n").slice(0, 60_000),
    );
    const lines = text
      .split("\n")
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l && l.length < 300)
      .slice(0, 25);
    if (!lines.length) return;
    const now = b();
    now.card = [...now.pinned, ...lines.filter((l) => !now.pinned.includes(l))].slice(0, 40);
    now.sinceDream = 0;
    now.dreamedAt = new Date().toISOString();
    keep();
  }

  const conclusions = {
    list: async ({ size = 100, filters }: { size?: number; filters?: { session_id?: { in?: string[] } } } = {}) => {
      const only = filters?.session_id?.in ? new Set(filters.session_id.in) : null;
      return page(
        newest(b()).filter((f) => !only || (f.sessionId && only.has(f.sessionId))),
        size,
      );
    },
    query: async (q: string, k = 10) => search(b().facts, q, k).map(out),
    create: async (items: { content: string; sessionId?: string | null; session_id?: string | null }[]) => {
      const bk = b();
      const made = items
        .map((i) => String(i.content ?? "").trim().slice(0, 1000))
        .filter(Boolean)
        .map((content, n) => ({ id: `lf_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`, content, sessionId: items[n]?.sessionId ?? items[n]?.session_id ?? null, createdAt: new Date().toISOString(), level: "explicit" }));
      bk.facts.push(...made);
      if (bk.facts.length > MAX_FACTS) bk.facts = newest(bk).slice(0, MAX_FACTS);
      bk.sinceDream += made.length;
      keep();
      // The card catches up once a few facts came in (or the first ones, while it's empty).
      if (bk.sinceDream >= 5 || (!bk.card.length && bk.facts.length >= 2)) dreamSoon();
      return made.map(out);
    },
    delete: async (id: string) => {
      const bk = b();
      bk.facts = bk.facts.filter((f) => f.id !== id);
      keep();
    },
    getMany: async (ids: string[]) => {
      const want = new Set(ids);
      return b().facts.filter((f) => want.has(f.id)).map(out);
    },
  };

  const owner = {
    getCard: async () => b().card,
    setCard: async (lines: string[]) => {
      const bk = b();
      const before = new Set(bk.card);
      // A line put in by hand (Pin, a copy) stays when the card is written again.
      bk.pinned = [...bk.pinned.filter((l) => lines.includes(l)), ...lines.filter((l) => !before.has(l) && !bk.pinned.includes(l))].slice(0, 40);
      bk.card = lines.slice(0, 40);
      keep();
    },
    /** The card's lines and the closest facts, as Honcho's representation reads (one fact a line). */
    context: async ({ searchQuery = "", maxConclusions = 12 }: { searchQuery?: string; searchTopK?: number; maxConclusions?: number; includeMostFrequent?: boolean } = {}) => ({
      representation: search(b().facts, searchQuery, maxConclusions)
        .map((f) => `- ${f.content}`)
        .join("\n"),
    }),
    /** A question about the user, answered by a model from the closest facts and the card. */
    chat: async (question: string) => {
      const bk = b();
      const near = search(bk.facts, question, 40);
      const recent = newest(bk).slice(0, 20);
      const facts = [...new Map([...near, ...recent].map((f) => [f.id, f])).values()];
      if (!facts.length && !bk.card.length) return "Nothing on that yet.";
      return ask(
        `Answer a question about ${ownerName()} from their long-term memory below, in one or two plain sentences. Use only what's there; if it doesn't say, answer that it isn't known yet. Newer facts win over older ones.`,
        `Card:\n${bk.card.map((l) => `- ${l}`).join("\n") || "(empty)"}\n\nFacts (newest first, with when they were learned):\n${facts
          .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
          .map((f) => `- ${f.createdAt.slice(0, 10)}: ${f.content}`)
          .join("\n")}\n\nQuestion: ${question}`,
        "medium",
      );
    },
    conclusions,
    message: (content: string, opts: { metadata?: Record<string, unknown> } = {}) => ({ content, metadata: opts.metadata ?? {} }),
  };
  /** A bot's peer: it says things in conversations, and nothing is learned about it. */
  const other = { ...owner, getCard: async () => [] as string[], setCard: async () => {}, conclusions: { ...conclusions, list: async () => page([], 1), query: async () => [] } };

  return {
    peer: async (id: string, opts?: unknown) => (opts ? other : owner),
    session: async () => ({ addPeers: async () => {}, addMessages: async () => {} }),
    conclusions,
    scheduleDream: async () => {
      await dream();
    },
  };
}
