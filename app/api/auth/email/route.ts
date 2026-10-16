import { EmailSignInProblem, signInProblem, startEmailSignIn } from "@/lib/server/horafirm-sign-in";

export const dynamic = "force-dynamic";

/** Continue with email, in the app: send a code to { email }. A refusal comes back in words to show ({ message }). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  try {
    return Response.json(await startEmailSignIn(String(body?.email ?? "").trim()));
  } catch (e) {
    if (e instanceof EmailSignInProblem) return Response.json({ error: "email", code: e.code, message: e.message }, { status: 400 });
    return signInProblem(e);
  }
}
