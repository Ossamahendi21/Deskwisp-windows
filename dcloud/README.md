# Deskwisp Cloud

The server behind Deskwisp. It's built in steps:

| Step | What | State |
|---|---|---|
| 2.1 | **Computers**: the bots' computers on E2B, at the paths the app already calls on Horafirm | done |
| 2.2 | **Accounts**: Clerk sign-in from the app, users and computers in Neon (Postgres) | done |
| 2.3 | **Keys and metering**: OpenAI and the other providers through the cloud, use counted per user | |
| 2.4 | **Billing**: plans and credit with Polar | |

## How signing in works

The app signs in the way it did with Horafirm, a device-code flow, so it needed no new code for it
(`lib/server/horafirm-sign-in.ts`, pointed here by `DESKWISP_HORAFIRM_ORIGIN`):

1. The app asks for a code: `POST /api/cli/auth/start` → a device code (the app keeps it) and a
   user code like `K7QM-3TXP`.
2. It opens `/cli/approve?code=K7QM-3TXP` in the browser. That page runs **Clerk** (Google or email);
   signed in, it shows "Sign in to Deskwisp on <PC>?" with the code, and **Allow** sends Clerk's
   session token to `POST /api/cli/auth/approve`, checked here against Clerk's keys (`src/clerk.ts`).
3. The app polls `POST /api/cli/auth/poll` and gets its key once (`dw_…`). From then on every call
   carries it (`Authorization: Bearer`); `GET /api/user/profile` says whose it is.

**Continue with Google** skips Clerk's form: the page sends the browser straight to Google
(`authenticateWithRedirect`), and Google comes back through `/cli/sso-callback` to the Allow step.

**Continue with email** never leaves the app: the app asks Deskwisp Cloud to send a code
(`POST /api/auth/email/start`), Clerk emails it (an account is made when the email is new), the user
types it in the app (`POST /api/auth/email/verify`) and the key comes back at once. Deskwisp Cloud
does Clerk's steps itself, as a native client of Clerk's Frontend API (`src/email-sign-in.ts`).

In the Clerk dashboard this needs, under **Configure**:
- **Email, phone, username**: Email address on; sign in and verify with **Email verification code**;
  no password, no username, no name required.
- **SSO connections**: Google on.
- **Attack protection**: Bot sign-up protection off (the app can't show Clerk's captcha).

Users, keys (only their SHA-256), sign-ins under way, workspaces and computers are in Postgres
(`DATABASE_URL`, Neon; `src/store-pg.ts`, migrations in `db/`, applied at start). Without
`DATABASE_URL` they're in a JSON file, for development.

## How the computers work

The app talks to Horafirm's REST API for its bots' computers (`lib/server/horafirm.ts`). Deskwisp Cloud
answers the same paths, so the app needs only `DESKWISP_HORAFIRM_ORIGIN` pointed here:

```
the app ──► Deskwisp Cloud ──► E2B sandbox (one per computer)
            /api/computers/…        Xvfb :99-:102, XFCE, Chrome, x11vnc + websockify
            /desktops/<id>/ws/…  ◄── live view (noVNC), checked by the computer's VNC password
```

- A **provider** only gives a Linux box with a shell (`src/providers/`). Everything a desktop needs
  runs inside the box with `template/deskwisp-display`: the four screens, screenshots, the mouse and
  keyboard. So the same API works on E2B, on a server of your own, or here for tests.
- An E2B computer **pauses** when nobody used it for `DESKWISP_IDLE_MINUTES` and wakes, with its
  memory, on the next use. Paused, it costs nothing; running, E2B bills by the second.
- What's not there yet: WebRTC (the app uses VNC), forks (a "clone" is a fresh computer), and the
  residential proxy.

## People: watching the bots from anywhere

`/watch` is a page for any browser, a phone too: sign in (Clerk) and watch your bots' computers
live, or take control. People you let in see the ones you shared with them (`src/people.ts`,
`src/watch-pages.ts`):

- The app's **People** sheet invites someone by email, with **View only** or **Full access**. Free
  lets nobody in, Pro 2 people, Max 5 (an invite counts until it's cancelled or runs out, in 7 days).
- The invite is a link to `/accept-invite`. Only someone signed in with the email invited can take
  it. With `RESEND_API_KEY` and `DESKWISP_MAIL_FROM` the link is emailed; without, the app shows it
  for you to send.
- Each computer has two VNC passwords: the full one, and a watch-only one that x11vnc itself holds
  to watching (no clicks, no keys). View only gets the watch-only one, through a ticket this server
  signs for two minutes.
- Taking someone's access away closes their open views at once. When someone with Full access goes
  (or is moved to View only), the computers get new passwords, so one they copied stops working.

## Try it

You need Node 22.6 or newer (24 runs TypeScript directly; on 22 add `--experimental-strip-types`).

**1. Put your settings in `dcloud/.env`** (git ignores it; keys never go in a command or a chat):

```bash
cp dcloud/.env.example dcloud/.env      # then fill in E2B_API_KEY and DESKWISP_API_KEYS
```

**2. Build the computer template on E2B** (once, about 10 minutes):

```bash
node --experimental-strip-types --env-file=dcloud/.env dcloud/template/build.ts
```

Then check it on real E2B, without the app (one computer, made, paused, woken and deleted: about a
cent). It saves two screenshots, `dcloud-smoke-1.png` and `dcloud-smoke-2.png`:

```bash
node --experimental-strip-types --env-file=dcloud/.env dcloud/scripts/smoke-e2b.ts
```

**3. Start Deskwisp Cloud:**

```bash
node --experimental-strip-types --env-file=dcloud/.env dcloud/src/server.ts
```

**4. Point the app at it**, in `%APPDATA%\Deskwisp\.env.local` (or `.env.local` for `next dev`):

```
DESKWISP_SELF_HOSTED=1
DESKWISP_HORAFIRM_ORIGIN=http://127.0.0.1:8791
DESKWISP_WEBRTC=0
OPENAI_API_KEY=sk-...
OPENAI_EXECUTOR_API_KEY=sk-...
```

Open the app: it asks you to sign in (Continue with Google or email opens the Clerk page), then
**Set up Wispy's computer**. (With `HORAFIRM_API_KEY=<a key from DESKWISP_API_KEYS>` it skips signing
in, for development.)

## Tests

```bash
node --experimental-strip-types --test dcloud/test/*.test.ts
```

The computers tests run the whole API with the local provider on real X displays: Xvfb, xdotool,
ImageMagick, x11vnc and websockify need to be installed (`apt install xvfb xdotool imagemagick
x11vnc websockify x11-utils xfwm4`). The accounts and people tests run on the JSON store, and on Postgres too
when `DESKWISP_TEST_DATABASE_URL` names a throwaway database (they drop and remake its `deskwisp`
schema).
