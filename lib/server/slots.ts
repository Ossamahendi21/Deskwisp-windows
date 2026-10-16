import "server-only";
import { botSlots, DISPLAYS, live, screenCount, type Bot, type ScreenSlot } from "@/lib/types";
import { horafirm, screenId } from "./horafirm";
import { sameComputer, workComputer } from "./screens";
import { bot, getState, update } from "./store";

/*
 * The bots' screens. Each bot has screens of its own (Bot.screens: 1, up to the plan's per bot: Free 1,
 * Pro 2, Max 4) and works only on them, never on another bot's. A screen isn't open until it's needed:
 * its bot opens it when a task starts there, or the user starts it from the bot's computer view. Then
 * it's on one of its computer's displays (state.slots), and a little after its work ends it closes
 * again, so only screens at work hold the computer's memory. A screen the user started stays open
 * until they close it.
 *
 * A computer has four displays, so at most four screens are open on it at once, whichever bots' they
 * are: a task waits for a display when all four are at work. A screen opens on the display it was on
 * last when it can (Bot.screenHomes): that display's Chrome has its sign-ins.
 */

/** Displays in the order screens open on them: the boot screen first (it's always up), then the others. */
const ORDER = [99, ...DISPLAYS.filter((d) => d !== 99)];

/** How long a bot's screen stays open after its work ends: a follow-up task picks it up as it was. */
export const CLOSE_AFTER_MS = 3 * 60_000;

/** Displays in use on a bot's computer, whoever's: tasks and their helpers, the user driving one, watches, and open screens. */
export function displaysTaken(botId: string) {
  const st = getState();
  const here = (id: string) => sameComputer(id, botId);
  const taken = new Set<number>();
  for (const s of st.sessions.filter((x) => here(x.botId))) {
    if (s.display !== undefined) taken.add(s.display);
    for (const d of s.helperScreens ?? []) taken.add(d);
  }
  if (st.takeover?.display !== undefined && here(st.takeover.botId)) taken.add(st.takeover.display);
  for (const w of st.watches ?? []) if (!w.mac && here(w.botId)) taken.add(w.display);
  for (const x of st.slots ?? []) if (here(x.botId)) taken.add(x.display);
  return taken;
}

/** Whether something is going on on a display: a task (or a helper), the user driving it, or a watch. */
export function displayBusy(botId: string, display: number) {
  const st = getState();
  const here = (id: string) => sameComputer(id, botId);
  return (
    st.sessions.some((s) => here(s.botId) && live(s) && (s.display === display || s.helperScreens?.includes(display))) ||
    (st.takeover?.display === display && here(st.takeover.botId)) ||
    (st.watches ?? []).some((w) => !w.mac && w.display === display && here(w.botId))
  );
}

/**
 * Where a task of this bot can work now: one of its open screens nothing's using (`open`), or one of
 * its closed screens with a free display to open it on. Null when all its screens are at work, or
 * the computer's displays all are. `prefer`: a display wanted (a thread picked up again).
 */
export function slotFor(b: Bot, prefer?: number): { n: number; display: number; opens: boolean } | null {
  const st = getState();
  const mine = botSlots(st, b);
  const openFree = mine.filter((x) => x.display !== undefined && !displayBusy(b.id, x.display));
  if (prefer !== undefined) {
    const there = openFree.find((x) => x.display === prefer);
    if (there) return { n: there.n, display: prefer, opens: false };
  }
  if (prefer === undefined && openFree.length) return { n: openFree[0].n, display: openFree[0].display!, opens: false };
  const closed = mine.filter((x) => x.display === undefined);
  if (!closed.length) return null;
  const taken = displaysTaken(b.id);
  const free = ORDER.filter((d) => !taken.has(d));
  if (prefer !== undefined) return free.includes(prefer) ? { n: closed[0].n, display: prefer, opens: true } : null;
  if (!free.length) return null;
  // The display each closed screen was on last, when it's free: its Chrome is there.
  for (const x of closed) {
    const home = b.screenHomes?.[x.n];
    if (home !== undefined && free.includes(home)) return { n: x.n, display: home, opens: true };
  }
  return { n: closed[0].n, display: free[0], opens: true };
}

/** A free display for one of a bot's screens: the one it was on last when that's free. Null when all four are at work. */
export function freeDisplayFor(b: Bot, n: number) {
  const taken = displaysTaken(b.id);
  const free = ORDER.filter((d) => !taken.has(d));
  const home = b.screenHomes?.[n];
  return home !== undefined && free.includes(home) ? home : (free[0] ?? null);
}

/** A bot's screen is open on a display (its work starts there, or the user started it). */
export function openSlot(botId: string, n: number, display: number, by: ScreenSlot["by"]) {
  update((st) => {
    const slots = (st.slots ??= []);
    const was = slots.find((x) => x.botId === botId && x.n === n);
    if (was) {
      was.display = display;
      was.idleSince = undefined;
      if (by === "user") was.by = "user";
    } else slots.push({ botId, n, display, by, since: Date.now() });
    const b = st.bots.find((x) => x.id === botId);
    if (b) b.screenHomes = { ...b.screenHomes, [n]: display };
  });
}

/** A task's work on a display ended (or the user let go of it): its screen closes in a while, unless it's the user's. */
export function slotIdle(botId: string, display: number) {
  update((st) => {
    const x = st.slots?.find((y) => y.display === display && sameComputer(y.botId, botId));
    if (x && x.by === "bot" && !x.idleSince) x.idleSince = Date.now();
  });
}

/** Close a bot's screen now: its display goes (never the boot screen, which only stops being the bot's). */
export async function closeSlot(botId: string, n: number) {
  const x = getState().slots?.find((y) => y.botId === botId && y.n === n);
  if (!x) return;
  update((st) => {
    st.slots = (st.slots ?? []).filter((y) => !(y.botId === botId && y.n === n));
  });
  const b = bot(botId);
  const computerId = b && workComputer(b).computerId;
  if (computerId && x.display !== 99) await horafirm.deleteScreen(computerId, screenId(x.display)).catch((e: Error) => console.warn(`[screens] closing :${x.display}: ${e.message}`));
}

/**
 * Close the screens whose work ended a while ago (nothing on them since), and forget open screens
 * whose bot went or has fewer screens now. Runs every half minute (sessions.ts).
 */
export async function sweepSlots(now = Date.now()) {
  const st = getState();
  for (const x of [...(st.slots ?? [])]) {
    const b = bot(x.botId);
    if (!b || x.n > screenCount(st, b)) {
      if (!b || !displayBusy(x.botId, x.display)) await closeSlot(x.botId, x.n);
      continue;
    }
    if (displayBusy(x.botId, x.display)) {
      if (x.idleSince) update(() => (x.idleSince = undefined));
      continue;
    }
    if (x.by === "bot" && !x.idleSince) update(() => (x.idleSince = now));
    else if (x.by === "bot" && x.idleSince && now - x.idleSince >= CLOSE_AFTER_MS) await closeSlot(x.botId, x.n);
  }
}

/** The computer went to sleep or was made again: none of its screens are open any more. */
export function forgetSlots(botId: string) {
  update((st) => {
    if (st.slots) st.slots = st.slots.filter((x) => !sameComputer(x.botId, botId));
  });
}
