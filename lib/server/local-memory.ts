import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudJson } from "./cloud";
import { openaiClient } from "./openai-client";
import { ownerName } from "./store";
import { recordTokens, usageTags } from "./usage";

/**
 * Deskwisp's own memory, where Honcho isn't used: the same memory (the user's card, the facts learned
 * about them, search, questions, tidying up) at no cost beyond a model call now and then.
 * lib/server/memory.ts uses it when neither Deskwisp Cloud nor this server has Honcho.
 *
 * Where it's kept (a store):
 * - cloudStore: Deskwisp Cloud (cloud/memory.ts, /v1/memory/<bank>), signed in. One memory wherever
 *   the user's bots answer: this PC, the cloud's own answers while the PC is away, the phone app.
 * - fileStore: a file on this PC for each bank (<user folder>/memory/<bank>.json), when there's no
 *   cloud (self-hosting).
 *
 * It answers the part of Honcho's SDK memory.ts uses (a client, its peers and sessions, and their
 * conclusions), so the rest of memory.ts is the same for both:
 * - Facts ("conclusions") come from what memory.ts saves: what the user says that's worth keeping
 *   (rememberMessage), what a bot remembers, what's pinned or copied. Each has its source (the chat or
 *   task it came from, when there's one).
 * - Search is by words, weighed by how rare each word is among the facts (a name counts for more than
 *   "the"), any language, newest first among equals (the cloud searches the same way).
 * - A question ("what's their shipping address?") is answered by a model from the closest facts and the card.
 * - The card is written from the facts by a model ("dreaming"): when asked, and by itself once a few
 *   new facts came in. Lines the user put in by hand (pinned) stay.
 * - What was said isn't kept (Honcho reads conversations; here only the facts are kept).
 */

export type Fact = { id: string; content: string; sessionId: string | null; createdAt: string; level: string };
type Card = { lines: string[]; pinned: string[] };

/** Where a bank is kept. */
export type MemoryStore = {
  card(): Promise<Card>;
  putCard(c: Card): Promise<void>;
  /** Newest first. `sessions`: only what was learned in those chats and tasks. */
  list(size: number, offset: number, sessions?: string[]): Promise<{ items: Fact[]; total: number }>;
  search(q: string, k: number): Promise<Fact[]>;
  create(items: { content: string; sessionId: string | null }[]): Promise<Fact[]>;
  remove(ids: string[]): Promise<void>;
  get(ids: string[]): Promise<Fact[]>;
};

const MAX_FACTS = 5000;
const MODEL = process.env.DESKWISP_MEMORY_MODEL ?? process.env.DESKWISP_CHAT_MODEL ?? "gpt-6.1-sol";

/* ---------------- Search by words ---------------- */

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when where which who will with you your about into than then there these those do does did not no yes can could would should".split(" "),
);
const words = (t: string) => (t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The facts closest to `q`, best first: each word of the question that's in a fact counts, rarer words more (cloud/memory.ts search, the same). */
export function search(facts: Fact[], q: string, k: number) {
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

/* ---------------- The stores ---------------- */

type FileBank = Card & { facts: Fact[] };
const g = globalThis as unknown as { deskwispLocalMemory?: { files: Map<string, FileBank>; dreams: Map<string, ReturnType<typeof setTimeout>>; since: Map<string, number> } };
const live = (g.deskwispLocalMemory ??= { files: new Map(), dreams: new Map(), since: new Map() });
const safe = (bank: string) => bank.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
const newest = (facts: Fact[]) => [...facts].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || (y.id < x.id ? -1 : 1));

/** A bank in a file on this PC. */
export function fileStore(dir: string, bank: string): MemoryStore {
  const file = join(dir, "memory", `${safe(bank)}.json`);
  const load = (): FileBank => {
    let b = live.files.get(file);
    if (b) return b;
    b = { lines: [], pinned: [], facts: [] };
    try {
      if (existsSync(file)) {
        const j = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Partial<FileBank> & { card?: string[] };
        b = { lines: j.lines ?? j.card ?? [], pinned: j.pinned ?? [], facts: j.facts ?? [] };
      }
    } catch {}
    live.files.set(file, b);
    return b;
  };
  const save = () => {
    mkdirSync(join(dir, "memory"), { recursive: true, mode: 0o700 });
    writeFileSync(/*turbopackIgnore: true*/ `${file}.tmp`, JSON.stringify(load()), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    card: async () => ({ lines: load().lines, pinned: load().pinned }),
    putCard: async (c) => {
      const b = load();
      b.lines = c.lines;
      b.pinned = c.pinned;
      save();
    },
    list: async (size, offset, sessions) => {
      const only = sessions ? new Set(sessions) : null;
      const all = newest(load().facts).filter((f) => !only || (f.sessionId && only.has(f.sessionId)));
      return { items: all.slice(offset, offset + size), total: all.length };
    },
    search: async (q, k) => search(load().facts, q, k),
    create: async (items) => {
      const b = load();
      const made = items.map((i) => ({ id: `lf_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`, content: i.content, sessionId: i.sessionId, createdAt: new Date().toISOString(), level: "explicit" }));
      b.facts.push(...made);
      if (b.facts.length > MAX_FACTS) b.facts = newest(b.facts).slice(0, MAX_FACTS);
      save();
      return made;
    },
    remove: async (ids) => {
      const gone = new Set(ids);
      const b = load();
      b.facts = b.facts.filter((f) => !gone.has(f.id));
      save();
    },
    get: async (ids) => {
      const want = new Set(ids);
      return load().facts.filter((f) => want.has(f.id));
    },
  };
}

/** A bank on Deskwisp Cloud (cloud/memory.ts), the user's own. */
export function cloudStore(bank: string): MemoryStore {
  const at = `/v1/memory/${encodeURIComponent(safe(bank))}`;
  const send = <T,>(path: string, method: string, body: unknown) => cloudJson<T>(`${at}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    card: async () => {
      const c = await cloudJson<Card>(at);
      return { lines: c.lines ?? [], pinned: c.pinned ?? [] };
    },
    putCard: async (c) => void (await send("/card", "PUT", c)),
    list: async (size, offset, sessions) => cloudJson<{ items: Fact[]; total: number }>(`${at}/facts?size=${Math.min(200, size)}&offset=${offset}${sessions ? `&sessions=${encodeURIComponent(sessions.join(","))}` : ""}`),
    search: async (q, k) => (await cloudJson<{ items: Fact[] }>(`${at}/search?q=${encodeURIComponent(q.slice(0, 1000))}&k=${Math.min(100, k)}`)).items,
    create: async (items) => {
      const made: Fact[] = [];
      for (let i = 0; i < items.length; i += 200) made.push(...(await send<{ items: Fact[] }>("/facts", "POST", { items: items.slice(i, i + 200) })).items);
      return made;
    },
    remove: async (ids) => {
      for (let i = 0; i < ids.length; i += 500) await send("/facts/delete", "POST", { ids: ids.slice(i, i + 500) });
    },
    get: async (ids) => {
      const got: Fact[] = [];
      for (let i = 0; i < ids.length; i += 500) got.push(...(await send<{ items: Fact[] }>("/facts/get", "POST", { ids: ids.slice(i, i + 500) })).items);
      return got;
    },
  };
}

/* ---------------- What the SDK hands back ---------------- */

const out = (f: Fact) => ({ id: f.id, content: f.content, sessionId: f.sessionId, createdAt: f.createdAt, level: f.level });

/** A page of conclusions, as the SDK's: its items, the total, the next page, and every one with for-await. */
async function page(store: MemoryStore, size: number, offset = 0, sessions?: string[]): Promise<Page> {
  const { items, total } = await store.list(size, offset, sessions);
  const next = offset + items.length;
  return {
    items: items.map(out),
    total,
    hasNextPage: items.length > 0 && next < total,
    getNextPage: async () => (items.length > 0 && next < total ? page(store, size, next, sessions) : null),
    async *[Symbol.asyncIterator]() {
      let p: Page | null = await page(store, size, offset, sessions);
      while (p) {
        for (const x of p.items) yield x;
        p = p.hasNextPage ? await p.getNextPage() : null;
      }
    },
  };
}
type Page = { items: ReturnType<typeof out>[]; total: number; hasNextPage: boolean; getNextPage: () => Promise<Page | null>; [Symbol.asyncIterator](): AsyncGenerator<ReturnType<typeof out>> };

async function ask(instructions: string, input: string, effort: "low" | "medium" = "low") {
  const res = await openaiClient().responses.create({ model: MODEL, reasoning: { effort }, instructions, input }, usageTags("memory"));
  recordTokens("memory", res.model, res.usage);
  return (res.output_text ?? "").trim();
}

/**
 * The client memory.ts makes for a bank when it runs without Honcho, on `store` (`key` names the bank
 * for its background work). Only the owner's peer has facts; bots' peers and sessions are there so
 * saving a conversation works.
 */
export function ownMemoryClient(store: MemoryStore, key: string) {
  /** The card again from the facts, in the background, a little after new facts stop coming. */
  const dreamSoon = () => {
    clearTimeout(live.dreams.get(key));
    const t = setTimeout(() => {
      live.dreams.delete(key);
      void dream().catch((e: Error) => console.warn(`[memory] the card: ${e.message}`));
    }, 45_000);
    t.unref?.();
    live.dreams.set(key, t);
  };

  async function dream() {
    const facts = (await store.list(200, 0)).items.concat((await store.list(200, 200)).items);
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
    const { pinned } = await store.card();
    await store.putCard({ lines: [...pinned, ...lines.filter((l) => !pinned.includes(l))].slice(0, 40), pinned });
    live.since.set(key, 0);
  }

  const conclusions = {
    list: async ({ size = 100, filters }: { size?: number; filters?: { session_id?: { in?: string[] } } } = {}) => page(store, size, 0, filters?.session_id?.in),
    query: async (q: string, k = 10) => (await store.search(q, k)).map(out),
    create: async (items: { content: string; sessionId?: string | null; session_id?: string | null }[]) => {
      const clean = items.map((i) => ({ content: String(i.content ?? "").trim().slice(0, 1000), sessionId: i.sessionId ?? i.session_id ?? null })).filter((i) => i.content);
      if (!clean.length) return [];
      const made = await store.create(clean);
      const since = (live.since.get(key) ?? 0) + made.length;
      live.since.set(key, since);
      // The card catches up once a few facts came in (or the first ones, while it's empty).
      if (since >= 5 || (since >= 2 && !(await store.card()).lines.length)) dreamSoon();
      return made.map(out);
    },
    delete: async (id: string) => store.remove([id]),
    getMany: async (ids: string[]) => (await store.get(ids)).map(out),
  };

  const owner = {
    getCard: async () => (await store.card()).lines,
    setCard: async (lines: string[]) => {
      const before = await store.card();
      const was = new Set(before.lines);
      // A line put in by hand (Pin, a fix, a copy) stays when the card is written again.
      const pinned = [...before.pinned.filter((l) => lines.includes(l)), ...lines.filter((l) => !was.has(l) && !before.pinned.includes(l))].slice(0, 40);
      await store.putCard({ lines: lines.slice(0, 40), pinned });
    },
    /** The closest facts, as Honcho's representation reads (one fact a line). */
    context: async ({ searchQuery = "", maxConclusions = 12 }: { searchQuery?: string; searchTopK?: number; maxConclusions?: number; includeMostFrequent?: boolean } = {}) => ({
      representation: (await store.search(searchQuery, maxConclusions)).map((f) => `- ${f.content}`).join("\n"),
    }),
    /** A question about the user, answered by a model from the closest facts and the card. */
    chat: async (question: string) => {
      const [c, near, recent] = await Promise.all([store.card(), store.search(question, 40), store.list(20, 0)]);
      const facts = [...new Map([...near, ...recent.items].map((f) => [f.id, f])).values()];
      if (!facts.length && !c.lines.length) return "Nothing on that yet.";
      return ask(
        `Answer a question about ${ownerName()} from their long-term memory below, in one or two plain sentences. Use only what's there; if it doesn't say, answer that it isn't known yet. Newer facts win over older ones.`,
        `Card:\n${c.lines.map((l) => `- ${l}`).join("\n") || "(empty)"}\n\nFacts (newest first, with when they were learned):\n${newest(facts)
          .map((f) => `- ${f.createdAt.slice(0, 10)}: ${f.content}`)
          .join("\n")}\n\nQuestion: ${question}`,
        "medium",
      );
    },
    conclusions,
    message: (content: string, opts: { metadata?: Record<string, unknown> } = {}) => ({ content, metadata: opts.metadata ?? {} }),
  };
  /** A bot's peer: it says things in conversations, and nothing is learned about it. */
  const empty: Page = { items: [], total: 0, hasNextPage: false, getNextPage: async () => null, async *[Symbol.asyncIterator]() {} };
  const other = { ...owner, getCard: async () => [] as string[], setCard: async () => {}, conclusions: { ...conclusions, list: async () => empty, query: async () => [] } };

  return {
    peer: async (_id: string, opts?: unknown) => (opts ? other : owner),
    session: async () => ({ addPeers: async () => {}, addMessages: async () => {} }),
    conclusions,
    scheduleDream: async () => {
      await dream();
    },
  };
}

/** For a self-hosted install: a bank in a file in the user's folder. */
export const localMemoryClient = (dir: string, bank: string) => ownMemoryClient(fileStore(dir, bank), `file:${dir}:${bank}`);
