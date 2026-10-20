/**
 * Main bots made before Deskwisp had ids of their own ("wispy", "wispy-2"…). Each becomes a Wispy id
 * ("wispy", or the next one free when a workspace's Wispy already has it), everywhere the state names
 * it: the bot, its chat ("bot:wispy"), messages, threads, usage. lib/server/store.ts does it as a state
 * loads; db/migrations/0015_wispy_ids.sql does the same in Deskwisp Cloud, the same way, so whichever
 * runs first, the ids come out alike. Plain TypeScript: no imports.
 */

const OLD = /^wispy(-\d+)?$/;
const OLD_IN_TEXT = /\bwispy(?:-\d+)?\b/g;

/** old id → new id, for the bots that have an old id (none: an empty map). */
export function oldBotIds(bots: { id: string }[]): Map<string, string> {
  const ids = bots.map((b) => b.id);
  const taken = new Set(ids);
  const map = new Map<string, string>();
  // In order (wispy, wispy-2, wispy-10), each to the first Wispy id nobody has.
  const old = ids.filter((id) => OLD.test(id)).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of old) {
    let next = "wispy";
    for (let n = 2; taken.has(next); n++) next = `wispy-${n}`;
    taken.add(next);
    map.set(id, next);
  }
  return map;
}

/** `value` with every old id in `map` swapped for its new one (whole ids only: "wispy" in "wispy-2" isn't one). */
export function renameBotIds<T>(value: T, map: Map<string, string>): T {
  if (!map.size) return value;
  const text = JSON.stringify(value);
  const out = text.replace(OLD_IN_TEXT, (id) => map.get(id) ?? id);
  return out === text ? value : (JSON.parse(out) as T);
}
