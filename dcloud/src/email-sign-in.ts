import { randomBytes } from "node:crypto";

/**
 * Signing in with an email code inside the app, with Clerk doing the work but never showing its form:
 * Deskwisp Cloud talks to Clerk's Frontend API the way a mobile app does (a "native" client: the
 * client token travels in the Authorization header, not a cookie). Clerk sends its own code email.
 *
 *   start(email):  an existing account → a sign-in by email code; no account yet → a sign-up, its
 *                  email verified by code. Either way Clerk emails a 6-digit code.
 *   verify(code):  Clerk checks it; done, the Clerk user is known (and the Clerk session it made is
 *                  ended: the app's key is what keeps the user signed in here).
 *
 * The Clerk dashboard needs: Email address on, sign-in and verification by Email code; no password and
 * no other required fields (see dcloud/README.md).
 */

export class EmailSignInError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Flow = {
  id: string;
  email: string;
  hostname: string;
  mode: "sign_in" | "sign_up";
  /** Clerk's id for the sign-in or sign-up under way. */
  attemptId: string;
  /** The native client's token, from Clerk's Authorization header. */
  token: string | null;
  tries: number;
  at: number;
};

type ClerkError = { code?: string; message?: string; long_message?: string; meta?: { param_name?: string } };
type Answer = { status: number; body: { response?: Record<string, unknown>; client?: Record<string, unknown>; errors?: ClerkError[] }; token: string | null };

const TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;
/** The clerk-js release this talks like (Clerk's Frontend API asks clients for their version). */
const JS_VERSION = "5.128.0";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailSignIn {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flows = new Map<string, Flow>();

  /** `host`: the instance's Frontend API host (from the publishable key). */
  constructor(opts: { host: string; fetchImpl?: typeof fetch }) {
    this.host = opts.host;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async fapi(method: "GET" | "POST", path: string, token: string | null, form?: Record<string, string>): Promise<Answer> {
    const url = new URL(`https://${this.host}/v1${path}`);
    url.searchParams.set("_is_native", "1");
    url.searchParams.set("_clerk_js_version", JS_VERSION);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(token ? { Authorization: token } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new EmailSignInError(502, "clerk_unreachable", `Couldn't reach Clerk: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as Answer["body"];
    return { status: res.status, body, token: res.headers.get("authorization") || token };
  }

  /** Clerk turned a step down: in words the app can show, and what to change in Clerk when it's the setup. */
  private refused(a: Answer, step: string): never {
    const e = a.body.errors?.[0] ?? {};
    const code = e.code ?? "clerk_error";
    const said = e.long_message || e.message || `Clerk answered ${a.status}`;
    console.warn(`[email sign-in] ${step}: ${a.status} ${code}: ${said}`);
    if (code === "form_code_incorrect") throw new EmailSignInError(400, code, "That code isn't right. Check the email and try again.");
    if (code === "verification_expired") throw new EmailSignInError(410, code, "That code expired. Send a new one.");
    if (code === "verification_failed" || code === "too_many_requests") throw new EmailSignInError(429, code, "Too many tries. Send a new code.");
    if (code === "form_identifier_exists") throw new EmailSignInError(409, code, "That email already has an account. Try again.");
    if (code.startsWith("form_param_format_invalid") || e.meta?.param_name === "email_address" || e.meta?.param_name === "identifier")
      throw new EmailSignInError(400, code, "That doesn't look like an email address.");
    if (code.includes("captcha"))
      throw new EmailSignInError(503, code, "Clerk wants a captcha for new accounts. Turn off Bot sign-up protection in Clerk (Configure → Attack protection).");
    if (code === "strategy_for_user_invalid" || code === "form_password_incorrect")
      throw new EmailSignInError(503, code, "Clerk isn't set up for email codes. Turn on Email verification code in Clerk (Configure → Email, phone, username).");
    throw new EmailSignInError(a.status >= 500 ? 502 : 400, code, said);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, f] of this.flows) if (now - f.at > TTL_MS) this.flows.delete(id);
  }

  /** Send a code to `email`: whether it's a sign-in or a new account, and the flow id the app answers with. */
  async start(email: string, hostname: string): Promise<{ flow: string; mode: Flow["mode"] }> {
    this.sweep();
    const addr = email.trim().toLowerCase();
    if (!EMAIL.test(addr) || addr.length > 254) throw new EmailSignInError(400, "bad_email", "That doesn't look like an email address.");

    // A client of our own for this flow (Clerk hands its token back in the Authorization header).
    let token: string | null = (await this.fapi("GET", "/client", null)).token;

    let mode: Flow["mode"] = "sign_in";
    let attemptId: string;
    const signIn = await this.fapi("POST", "/client/sign_ins", token, { identifier: addr });
    token = signIn.token;
    if (signIn.status < 300) {
      const si = signIn.body.response as { id: string; supported_first_factors?: { strategy: string; email_address_id?: string }[] };
      const factor = si.supported_first_factors?.find((f) => f.strategy === "email_code");
      if (!factor?.email_address_id)
        throw new EmailSignInError(503, "no_email_code", "Clerk isn't set up for email codes. Turn on Email verification code in Clerk (Configure → Email, phone, username).");
      const prep = await this.fapi("POST", `/client/sign_ins/${si.id}/prepare_first_factor`, token, { strategy: "email_code", email_address_id: factor.email_address_id });
      token = prep.token;
      if (prep.status >= 300) this.refused(prep, "prepare sign-in");
      attemptId = si.id;
    } else if (signIn.body.errors?.[0]?.code === "form_identifier_not_found") {
      // No account yet: one is made, its email verified by the same kind of code.
      mode = "sign_up";
      const up = await this.fapi("POST", "/client/sign_ups", token, { email_address: addr });
      token = up.token;
      if (up.status >= 300) this.refused(up, "sign up");
      const su = up.body.response as { id: string };
      const prep = await this.fapi("POST", `/client/sign_ups/${su.id}/prepare_verification`, token, { strategy: "email_code" });
      token = prep.token;
      if (prep.status >= 300) this.refused(prep, "prepare sign-up");
      attemptId = su.id;
    } else this.refused(signIn, "sign in");

    const id = randomBytes(24).toString("base64url");
    this.flows.set(id, { id, email: addr, hostname, mode, attemptId, token, tries: 0, at: Date.now() });
    return { flow: id, mode };
  }

  /** Check the code: the Clerk user it proves, and the Clerk session that made (to be ended). */
  async verify(flowId: string, code: string): Promise<{ clerkId: string; sessionId: string | null; email: string; hostname: string }> {
    const f = this.flows.get(flowId);
    if (!f || Date.now() - f.at > TTL_MS) throw new EmailSignInError(410, "expired", "That code expired. Send a new one.");
    if (++f.tries > MAX_TRIES) {
      this.flows.delete(flowId);
      throw new EmailSignInError(429, "too_many_tries", "Too many tries. Send a new code.");
    }
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) throw new EmailSignInError(400, "form_code_incorrect", "The code has 6 digits.");

    const a =
      f.mode === "sign_in"
        ? await this.fapi("POST", `/client/sign_ins/${f.attemptId}/attempt_first_factor`, f.token, { strategy: "email_code", code: digits })
        : await this.fapi("POST", `/client/sign_ups/${f.attemptId}/attempt_verification`, f.token, { strategy: "email_code", code: digits });
    f.token = a.token;
    if (a.status >= 300) this.refused(a, f.mode === "sign_in" ? "check sign-in code" : "check sign-up code");

    const r = a.body.response as { status?: string; created_session_id?: string | null; created_user_id?: string | null; missing_fields?: string[] };
    if (r.status !== "complete") {
      const missing = r.missing_fields?.length ? ` (${r.missing_fields.join(", ")})` : "";
      console.warn(`[email sign-in] not complete after the code: ${r.status}${missing}`);
      throw new EmailSignInError(
        503,
        "not_complete",
        `Clerk wants more than an email${missing}. In Clerk, make the email the only thing an account needs (no password, no name).`,
      );
    }
    this.flows.delete(flowId);
    const sessionId = r.created_session_id ?? null;
    // The user: a sign-up says it outright; a sign-in through the session it made.
    let clerkId = r.created_user_id ?? null;
    if (!clerkId && sessionId) {
      const sessions = ((a.body.client as { sessions?: { id: string; user?: { id: string } }[] } | undefined)?.sessions ?? []) as { id: string; user?: { id: string } }[];
      clerkId = sessions.find((s) => s.id === sessionId)?.user?.id ?? null;
    }
    if (!clerkId) throw new EmailSignInError(502, "no_user", "Clerk didn't say who signed in. Try again.");
    return { clerkId, sessionId, email: f.email, hostname: f.hostname };
  }
}
