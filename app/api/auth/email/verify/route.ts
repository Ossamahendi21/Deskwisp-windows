import { EmailSignInProblem, signInProblem, verifyEmailSignIn } from "@/lib/server/horafirm-sign-in";

export const dynamic = "force-dynamic";

/** The code from the email ({ code }): signed in when it's right, like an approved sign-in (app/api/auth/poll). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  try {
    return Response.json(await verifyEmailSignIn(String(body?.code ?? "")));
  } catch (e) {
    if (e instanceof EmailSignInProblem) return Response.json({ error: "email", code: e.code, message: e.message }, { status: 400 });
    return signInProblem(e);
  }
}
