# Deskwisp Cloud

The server behind Deskwisp. It's built in steps:

| Step | What | State |
|---|---|---|
| 2.1 | **Computers**: the bots' computers on E2B, at the paths the app already calls on Horafirm | done |
| 2.2 | **Accounts**: Clerk sign-in from the app, users and computers in Neon (Postgres) | next |
| 2.3 | **Keys and metering**: OpenAI and the other providers through the cloud, use counted per user | |
| 2.4 | **Billing**: plans and credit with Polar | |

## How the computers work

The app talks to Horafirm's REST API for its bots' computers (`lib/server/horafirm.ts`). Deskwisp Cloud
answers the same paths, so the app needs only `DESKWISP_HORAFIRM_ORIGIN` pointed here:

```
the app ──► Deskwisp Cloud ──► E2B sandbox (one per computer)
            /api/computers/…        Xvfb :99-:102, XFCE, Chrome, x11vnc + websockify
            /desktops/<id>/ws/…  ◄── live view (noVNC), checked by the computer's VNC password
```

- A **provider** only gives a Linux box with a shell (`src/providers/`). Everything a desktop needs
  runs inside the box with `template/deskwisp-screens`: the four screens, screenshots, the mouse and
  keyboard. So the same API works on E2B, on a server of your own, or here for tests.
- An E2B computer **pauses** when nobody used it for `DESKWISP_IDLE_MINUTES` and wakes, with its
  memory, on the next use. Paused, it costs nothing; running, E2B bills by the second.
- What's not there yet: WebRTC (the app uses VNC), forks (a "clone" is a fresh computer), sharing a
  workspace with other people, and the residential proxy.

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

**3. Start Deskwisp Cloud:**

```bash
node --experimental-strip-types --env-file=dcloud/.env dcloud/src/server.ts
```

**4. Point the app at it**, in `%APPDATA%\Deskwisp\.env.local` (or `.env.local` for `next dev`):

```
DESKWISP_SELF_HOSTED=1
DESKWISP_HORAFIRM_ORIGIN=http://127.0.0.1:8791
HORAFIRM_API_KEY=<a key from DESKWISP_API_KEYS>
OPENAI_API_KEY=sk-...
OPENAI_EXECUTOR_API_KEY=sk-...
```

Open the app, then **Set up Wispy's computer**.

## Tests

```bash
node --experimental-strip-types --test dcloud/test/computers.test.ts
```

They run the whole API with the local provider on real X displays: Xvfb, xdotool, ImageMagick,
x11vnc and websockify need to be installed (`apt install xvfb xdotool imagemagick x11vnc websockify
x11-utils xfwm4`).
