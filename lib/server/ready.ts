import "server-only";
import { stateReady } from "./store";

/**
 * For a route that changes the state: 409 while there's no state to change (the Mac app signed out,
 * or the signed-in user's state still loading from Deskwisp Cloud), so nothing is done for nobody. Null
 * when the route can go on.
 */
export function notReady(): Response | null {
  return stateReady() ? null : Response.json({ error: "Deskwisp is still loading your account. Try again in a moment." }, { status: 409 });
}
