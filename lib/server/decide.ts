import "server-only";
import { appHeaders } from "./app-version";
import { cloudProxy, cloudSession } from "./cloud";
import { openaiClient } from "./openai-client";
import { stateEpoch } from "./store";
import { recordDecide, recordTokens, usageTags } from "./usage";

/**
 * Small, fast judgment calls ("is this a sign-in page?", "is the bot waiting on the user?") go to
 * TypeSafe's Jev: typed answers with calibrated probabilities in ~200 ms, for a fraction of a
 * cent per thousand. Text only, read literally, so questions spell out exactly what each answer
 * means. Swap the backend here (e.g. OpenAI's Decisions API) without touching callers. Signed in
 * with Horafirm it goes through Deskwisp Cloud (lib/server/cloud.ts), when the cloud runs it; self-hosting,
 * on TYPESAFE_API_KEY. Each call is counted as a quick check (usage.ts recordDecide), at the tokens
 * Typesafe says it read, for the bot it's about when the caller says (`opts.botId`); through the
 * cloud, the cloud counts and prices it too (what AI credit pays).
 *
 * Without Jev (no Typesafe key here or on the cloud), the same questions go to a small OpenAI call with
 * a strict JSON answer instead (decideWithOpenAI): slower and dearer per question, but every check
 * still gets an answer. DESKWISP_DECIDE_MODEL picks its model.
 */

type Text = string | Record<string, unknown> | unknown[];
export type Question =
  | { type: "choice"; instructions: Text; criteria: Record<string, Text | null> }
  | { type: "noul"; instructions: Text; criteria?: { true?: Text; false?: Text } }
  | { type: "score"; instructions: Text; criteria: Text[] };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

/** Ask several questions about one state in a single call. Null when Jev isn't set up or fails. */
export async function decide<K extends string>(
  state: Text,
  questions: Partial<Record<K, Question>>,
  /** `jevOnly`: no OpenAI stand-in (reads that run on every page change, too many to pay a model for). */
  opts: { botId?: string; jevOnly?: boolean } = {},
): Promise<Partial<Record<K, Answer>> | null> {
  const via = cloudProxy("typesafe");
  const key = via ? via.key : process.env.TYPESAFE_API_KEY;
  if (!key || (via && !(await cloudSession().catch(() => null))?.typesafe)) return opts.jevOnly ? null : decideWithOpenAI(state, questions, opts);
  const body = JSON.stringify({ model: "jev-latest", state, questions });
  // Counted for the user whose state this was asked for (the ledger is in their state).
  const epoch = stateEpoch();
  try {
    const res = await fetch(`${via ? via.url : "https://api.typesafe.ai"}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(via ? { ...usageTags("decide", opts.botId).headers, ...appHeaders() } : {}) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const answer = (await res.json()) as { answers: Partial<Record<K, Answer>>; model?: string; usage?: { input_tokens?: number } | null };
    // What Typesafe read (about 4 bytes a token when it doesn't say), as the cloud counts it.
    const said = answer.usage?.input_tokens;
    recordDecide(answer.model ?? "jev-latest", typeof said === "number" && Number.isFinite(said) && said >= 0 ? said : Math.ceil(Buffer.byteLength(body) / 4), opts.botId, epoch);
    return answer.answers;
  } catch (e) {
    console.warn("[decide]", (e as Error).message);
    return null;
  }
}

export const chose = (a: Answer | undefined) => (a?.type === "choice" ? a : undefined);
export const yes = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : undefined);

// A small model: these are short yes/no and pick-one questions (Free runs on its own cheap one anyway).
const DECIDE_MODEL = process.env.DESKWISP_DECIDE_MODEL ?? "gpt-6-luna";

/** The JSON answer one question takes from the model: a choice's key, or how likely a yes/no is true, or a score's place. */
function answerSchema(q: Question) {
  if (q.type === "choice") return { type: "object", additionalProperties: false, required: ["choice"], properties: { choice: { type: "string", enum: Object.keys(q.criteria) } } };
  if (q.type === "noul") return { type: "object", additionalProperties: false, required: ["likely"], properties: { likely: { type: "number", description: "0 to 1: how likely the answer is true" } } };
  return { type: "object", additionalProperties: false, required: ["level"], properties: { level: { type: "integer", description: `0 to ${q.criteria.length - 1}: which criterion fits` } } };
}

/**
 * The questions answered by OpenAI when Jev isn't set up: each as Jev would (a choice with its
 * probabilities, a yes/no's likelihood, a score from 0 to 1), from a strict JSON answer. Null when the
 * call fails (as Jev's callers expect), or when OpenAI isn't reachable at all.
 */
async function decideWithOpenAI<K extends string>(state: Text, questions: Partial<Record<K, Question>>, opts: { botId?: string }): Promise<Partial<Record<K, Answer>> | null> {
  const keys = Object.keys(questions) as K[];
  if (!keys.length) return {};
  const epoch = stateEpoch();
  const schema = { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, answerSchema(questions[k]!)])) };
  const instructions = [
    "You answer small questions about the state of an app, for the app's code. Read the state and each question literally, and answer only from what the state shows.",
    "- choice: the key of the criterion that fits best.",
    "- noul: likely, from 0 to 1, how likely the answer is true (its criteria say what true and false mean).",
    "- score: level, the index of the criterion that fits best (they go from lowest to highest).",
  ].join("\n");
  try {
    const res = await openaiClient().responses.create(
      {
        model: DECIDE_MODEL,
        reasoning: { effort: "low" },
        store: false,
        instructions,
        input: JSON.stringify({ state, questions }),
        text: { format: { type: "json_schema", name: "answers", strict: true, schema } },
      },
      { ...usageTags("decide", opts.botId), timeout: 20_000, maxRetries: 1 },
    );
    recordTokens("decide", res.model, res.usage, opts.botId, epoch);
    const out = JSON.parse(res.output_text) as Record<string, { choice?: string; likely?: number; level?: number }>;
    const answers: Partial<Record<K, Answer>> = {};
    for (const k of keys) {
      const q = questions[k]!;
      const a = out[k];
      if (!a) continue;
      if (q.type === "choice" && typeof a.choice === "string" && a.choice in q.criteria)
        answers[k] = { type: "choice", choice: a.choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(q.criteria).map((c) => [c, c === a.choice ? 0.9 : 0.1 / Math.max(1, Object.keys(q.criteria).length - 1)])) };
      else if (q.type === "noul" && typeof a.likely === "number") answers[k] = { type: "noul", noul: Math.min(1, Math.max(0, a.likely)) };
      else if (q.type === "score" && typeof a.level === "number" && q.criteria.length) {
        const level = Math.min(q.criteria.length - 1, Math.max(0, Math.round(a.level)));
        answers[k] = { type: "score", score: q.criteria.length > 1 ? level / (q.criteria.length - 1) : 1, confidence: 0.9, probabilities: { [String(level)]: 0.9 } };
      }
    }
    return answers;
  } catch (e) {
    console.warn("[decide] (OpenAI)", (e as Error).message);
    return null;
  }
}
