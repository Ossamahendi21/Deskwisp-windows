import { config } from "./config.ts";
import { open, seal } from "./crypto.ts";
import { ensureUserRow, query } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";

/**
 * Bots' phone numbers on the user's own AgentPhone account (deskwisp.phone_keys, db/migrations/0016):
 * the user signs up at AgentPhone, pays it for their numbers, calls and texts, and gives Deskwisp their
 * API key here. Every AgentPhone call of theirs then goes with that key (proxy.ts) instead of Deskwisp's
 * and its sub-account, and costs no AI credit (usage.ts records it at $0, so it's still counted).
 * Webhooks still come to the cloud (each agent's, set by the app through the proxy), and calls and
 * texts are answered the same way.
 *
 *   GET    /v1/phone/key   { connected, last4? }
 *   PUT    /v1/phone/key   { key }: checked with AgentPhone first; a key it refuses isn't kept
 *   DELETE /v1/phone/key   forgets it (the numbers stay on the user's AgentPhone account)
 */

/** Where people sign up for AgentPhone, shown in the app (a referral link can go here). */
export const AGENTPHONE_SIGNUP = "https://agentphone.ai";

/** The user's own AgentPhone key, or null. */
export async function ownPhoneKey(userId: string): Promise<string | null> {
  const r = await query<{ key_sealed: string }>("SELECT key_sealed FROM deskwisp.phone_keys WHERE user_id = $1", [userId]);
  const sealed = r.rows[0]?.key_sealed;
  if (!sealed) return null;
  try {
    return open(sealed);
  } catch (e) {
    console.warn(`[phone-key] ${userId}'s key can't be opened: ${(e as Error).message}`);
    return null;
  }
}

/** Whether AgentPhone takes the key: true, false (refused), or an error when AgentPhone can't be asked. */
async function agentphoneTakes(key: string): Promise<boolean> {
  const res = await fetch(`${config.upstream.agentphone()}/v1/numbers?limit=1`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) throw new HttpError(502, "Couldn't reach AgentPhone. Try again in a minute.");
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new HttpError(502, `AgentPhone answered ${res.status}. Try again in a minute.`);
  return true;
}

/** An AgentPhone key as it's pasted: one line of plain characters. */
const KEY = /^[A-Za-z0-9_\-.:]{16,256}$/;

export const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/phone/key",
    auth: "user",
    handle: async (_req, res, { user }) => {
      const r = await query<{ last4: string }>("SELECT last4 FROM deskwisp.phone_keys WHERE user_id = $1", [user!.id]);
      sendJson(res, 200, r.rows[0] ? { connected: true, last4: r.rows[0].last4, signup: AGENTPHONE_SIGNUP } : { connected: false, signup: AGENTPHONE_SIGNUP });
    },
  },
  {
    method: "PUT",
    path: "/v1/phone/key",
    auth: "user",
    handle: async (req, res, { user }) => {
      const { key } = await readJson<{ key?: unknown }>(req);
      const k = typeof key === "string" ? key.trim() : "";
      if (!KEY.test(k)) throw new HttpError(400, "That doesn't look like an AgentPhone API key. Copy it again from AgentPhone (Settings, API keys).");
      if (!(await agentphoneTakes(k))) throw new HttpError(400, "AgentPhone didn't accept that key. Check it's the whole key, and still active.");
      await ensureUserRow(user!.id);
      await query(
        `INSERT INTO deskwisp.phone_keys (user_id, key_sealed, last4) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET key_sealed = EXCLUDED.key_sealed, last4 = EXCLUDED.last4, updated_at = now()`,
        [user!.id, seal(k), k.slice(-4)],
      );
      sendJson(res, 200, { connected: true, last4: k.slice(-4) });
    },
  },
  {
    method: "DELETE",
    path: "/v1/phone/key",
    auth: "user",
    handle: async (_req, res, { user }) => {
      await query("DELETE FROM deskwisp.phone_keys WHERE user_id = $1", [user!.id]);
      sendJson(res, 200, { connected: false });
    },
  },
];
