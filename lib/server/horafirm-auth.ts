import "server-only";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { bindSignIn, getState, releaseSignOut, update } from "./store";

/**
 * Signing in with Horafirm. A Deskwisp user is an Horafirm user: the app signs in through Horafirm's device-code
 * flow (the same one the Horafirm CLI and Horafirm for Mac use), and the Horafirm API key it gets back lives in
 * the Mac's Keychain. Everything Deskwisp does on Horafirm (the "deskwisp" workspace, the bots' computers, the
 * account page) runs on that key, so it all lands in the user's own Horafirm account and plan.
 *
 * DESKWISP_HORAFIRM_ORIGIN points Deskwisp at another Horafirm (staging, local); the default is production.
 */

export const horafirmOrigin = () => (process.env.DESKWISP_HORAFIRM_ORIGIN || "https://app.deskwisp.com").replace(/\/+$/, "");

const KEY_ACCOUNT = "horafirm-api-key";

export type HorafirmUser = { id: string; email?: string; name?: string };

// deskwispHorafirmWorkspace is horafirm.ts's cache of the user's "deskwisp" workspace id; a change of user clears it.
const g = globalThis as unknown as {
  deskwispHorafirmKey?: string | null;
  deskwispHorafirmKeyLoad?: Promise<string | null>;
  /** When the Keychain last had no key for us (Infinity after a sign-out: there's none until the next sign-in). */
  deskwispHorafirmKeyMissAt?: number;
  deskwispHorafirmWorkspace?: unknown;
};

/** How long a failed Keychain read stands before it's tried again (it may have been locked, or a prompt turned down). */
const RETRY_MS = 10_000;

/** Read the signed-in key from the Keychain: once per server process, and again a little later if it wasn't there. */
export function loadHorafirmKey(): Promise<string | null> {
  if (g.deskwispHorafirmKey) return Promise.resolve(g.deskwispHorafirmKey);
  if (g.deskwispHorafirmKey === null && Date.now() - (g.deskwispHorafirmKeyMissAt ?? 0) < RETRY_MS) return Promise.resolve(null);
  const load = (g.deskwispHorafirmKeyLoad ??= getSecret(KEY_ACCOUNT).then((k) => {
    // A sign-in or sign-out while this read was out has the last word.
    if (g.deskwispHorafirmKeyLoad !== load) return g.deskwispHorafirmKey ?? null;
    g.deskwispHorafirmKeyLoad = undefined;
    g.deskwispHorafirmKey = k || null;
    if (!k) g.deskwispHorafirmKeyMissAt = Date.now();
    return g.deskwispHorafirmKey;
  }));
  return load;
}

function setKey(key: string | null) {
  g.deskwispHorafirmKey = key;
  g.deskwispHorafirmKeyLoad = undefined;
  g.deskwispHorafirmKeyMissAt = key ? undefined : Infinity;
  g.deskwispHorafirmWorkspace = undefined;
}

/** The signed-in user's Horafirm API key, if it's been loaded (call loadHorafirmKey() first on a cold start). */
export const horafirmKey = (): string | null => g.deskwispHorafirmKey ?? null;

/** Who's signed in (kept in state so the UI can show it without a round trip). */
export const signedInUser = (): HorafirmUser | null => getState().account?.user ?? null;

export async function signIn(apiKey: string, user: HorafirmUser) {
  const before = signedInUser();
  const was = keyNow();
  // First this user's own state is loaded (from Deskwisp Cloud, their file, or Postgres): the sign-in is refused if it can't be.
  await bindSignIn(user.id, apiKey);
  // Their key comes in with their state, at once, before the Keychain is written: background work (the
  // 10-minute look at the bots' computers, routing through this Mac, a screen's view) never runs on the
  // last user's key over this one's state. A computer of theirs that the last key can't see would look
  // deleted, and be let go.
  setKey(apiKey);
  try {
    await setSecret(KEY_ACCOUNT, apiKey);
  } catch (e) {
    // The key that's still in use is the one before; so must the state be, or one user's key would run over another's state.
    await giveBack(before, was);
    throw e;
  }
  update((s) => {
    s.account = { user, signedInAt: Date.now() };
    // Running out of AI credit was the last account's.
    s.credits = undefined;
  });
}

/** The key in memory as it stands (to put back as it was: giveBack). */
const keyNow = () => ({ key: g.deskwispHorafirmKey, missAt: g.deskwispHorafirmKeyMissAt });

/** Undo a sign-in's swap of the state: back to whoever was signed in, or to nobody's. */
async function giveBack(before: HorafirmUser | null, was: ReturnType<typeof keyNow>) {
  const beforeKey = was.key ?? null;
  try {
    await releaseSignOut();
    // Nobody's state is in memory now: the key before comes back with it, before theirs loads.
    setKey(beforeKey);
    g.deskwispHorafirmKey = was.key;
    g.deskwispHorafirmKeyMissAt = was.missAt;
    if (before) {
      await bindSignIn(before.id, beforeKey ?? undefined);
      update((s) => (s.account = { user: before, signedInAt: s.account?.signedInAt ?? Date.now() }));
    }
  } catch (e) {
    // Couldn't put it back: drop the old key from memory too, so nothing runs on it over the wrong state.
    // It's read again later (authStatus then binds its user's state first).
    console.error(`[sign-in] couldn't go back to the state before: ${(e as Error).message}`);
    setKey(null);
    g.deskwispHorafirmKeyMissAt = Date.now();
  }
}

export async function signOut() {
  await releaseSignOut();
  await deleteSecret(KEY_ACCOUNT);
  setKey(null);
  update((s) => {
    s.account = undefined;
    s.credits = undefined;
  });
}
