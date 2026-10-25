# Deskwisp: handoff for a new session

Everything a new Claude Code session needs to carry on. Read it whole before doing anything, then the files
it points to as the task needs them. State as of **Oct 25, 2026**.

## 1. Working with Ossama

- **Ossama** (GitHub `Ossamahendi21`, `ossamahindi2@gmail.com`) owns Deskwisp. He writes in **Moroccan
  Darija** (Arabic script, sometimes French/English words). Answer in Darija, short and clear; code,
  commits and docs stay in English.
- He's not a full-time developer: give him exact commands to paste (Git Bash on Windows, or the server's
  shell), one block per place, and say what each block does in one line.
- His PC: Windows 11, the repo at `D:\Downloads\Deskwisp-windows` (`/d/Downloads/Deskwisp-windows` in Git
  Bash), branch `main`, remote `https://github.com/Ossamahendi21/Deskwisp-windows.git` (private).
- **Commits:** authored by him (his git config). End messages with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and **never** a `Claude-Session:` line.
  Push only when he asks, or as part of a release he asked for.
- **Secrets:** never ask him to paste a key, token, password or SSH key into the chat. Server keys live
  only in `/etc/deskwisp/cloud.env` and `/etc/deskwisp/dcloud.env` (he edits them with `sudo nano`);
  local ones in `.env.local` / `.env.release` (never committed). The repo is scanned by gitleaks in CI.
- **Words:** the product is **Deskwisp**; the company is **Horafirm LLC** (it's the Microsoft Store
  publisher). "Horafirm" appears only in code names (`lib/server/horafirm*.ts`, `DESKWISP_HORAFIRM_*`,
  `HORAFIRM_API_KEY`), never in text a user reads: there it's "Deskwisp" or "Deskwisp Cloud".
  The project started as a port of an open-source app by another company, with that company's permission;
  **their name and the old product's name must not appear anywhere in the repo, its history or the app**.
  The history was rewritten on Oct 25 to remove them; keep it that way.

## 2. What Deskwisp is

A Windows app that gives a small business a team of AI agents ("AI employees"). Wispy, the main bot, runs
the team; the user adds bots (bookkeeper, sales, support…). The bots work on a cloud computer (watch live,
take control), ask before sending/buying/deleting, remember the business, use ~1,400 apps (Composio), and
are reachable in the app, by email, by text/iMessage, by voice, and in Telegram, Discord and Slack.
Skills and plugins come from a free library or the user's own (`/` in a chat). Website: **deskwisp.com**.

**Plans** (`cloud/protocol.ts` `DESKWISP_TIERS` and `dcloud/src/plans.ts`, keep them in step):
Free $0 (1 screen per bot, 10 computer hours/month, $1 AI credit/month) · Pro $29/month (2 screens, 60 h,
$10, an email for the main bot, share with 2) · Max $199/month (4 screens, 300 h, $100, up to 5 emails,
share with 5). One computer on every plan. Extra AI credit $5 to $1,000, one-time (Polar). Phone numbers
are on the user's own AgentPhone account.

## 3. How it's built

| Part | Where | Runs on |
|---|---|---|
| Windows app (Electron shell, updater, Vault) | `desktop/win-main.cjs`, `desktop/win-update.cjs`, `desktop/update.html`, `build/installer.nsh` | The user's PC |
| App server (Next.js 16, port 3210, 127.0.0.1) | `app/`, `components/app/`, `lib/server/` | The user's PC, started by the app |
| Deskwisp accounts and computers ("dcloud") | `dcloud/` | The VPS, `app.deskwisp.com` (port 8791) |
| Deskwisp services ("cloud": keys, metering, webhooks, state, memory, phone agent) | `cloud/`, migrations in `db/migrations/` | The VPS, `cloud.deskwisp.com/api` (port 8790) |
| What runs on the bots' computers | `vm/`, `dcloud/template/` (E2B) | E2B sandboxes |
| Website, terms, privacy | `deploy/vps/site/` | The VPS (nginx) |

- Server: an Oracle Cloud VPS (aarch64), repo cloned at `/opt/deskwisp`, Postgres on **Neon**.
  `docs/DEPLOY.md` and `docs/SERVICES.md` explain the servers, keys and costs.
- Sign-in: Clerk (Google or email), production instance. Payments: Polar (live).
- Memory: Deskwisp's own, kept in Deskwisp Cloud (`cloud/memory.ts`, `lib/server/local-memory.ts`);
  Honcho only if configured.
- Quick yes/no checks (`lib/server/decide.ts`) use TypeSafe if set, otherwise OpenAI.
- The Vault on Windows: an AES-256-GCM sealed file whose key Windows DPAPI keeps (`lib/server/keychain.ts`).
- The phone already has a backend: `cloud/agent.ts` answers the main bot's chat from a phone
  (`GET/POST /v1/agent`, `/v1/agent/messages`, client header `x-deskwisp-client: ios`,
  migration `0013_ios_client.sql`). The cloud answers it itself, so it works when the PC is off.

## 4. Daily commands

```bash
npm ci
npm run app:win                          # the app, with `next dev`
npx next typegen && npx tsc --noEmit -p . && npm run lint
npx tsc -p cloud/tsconfig.json --noEmit && npx tsc -p dcloud/tsconfig.json --noEmit
node --conditions=react-server scripts/test-<name>.mjs        # app suites: all 24+ pass
node --test "cloud/test/core-*.test.ts"                       # needs DESKWISP_TEST_DATABASE_URL (a test Postgres)
node --test "cloud/test/edge-*.test.ts" cloud/test/server.test.ts
(cd dcloud && node --test)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, gitleaks and the cloud tests on a fresh Postgres on
every push. All of it was green on Oct 25.

## 5. Releasing

**The app (website download + auto-update):**
```bash
printf '# Deskwisp 0.1.13\n\n- What changed\n' > docs/releases/v0.1.13.md
git add docs/releases/v0.1.13.md && git commit -m "What's new in 0.1.13"
bash scripts/release-win.sh 0.1.13        # builds, smoke-tests, uploads to deskwisp.com, commits + tags
git push && git push --tags
```
Installed apps find it within the hour; the update window shows the `- ` lines.

**Microsoft Store** (after release-win, same version, on Windows):
```bash
bash scripts/release-store.sh             # → dist-store/Deskwisp-<version>-x64.appx
```
Upload it in Partner Center as a new submission. Store identity (`electron-builder.win.json` → `appx`):
`HorafirmLLC.Deskwisp`, publisher `CN=0472D7ED-2092-4944-9FB1-6C60A776FCC5`, Store ID `9N9QZ5QT9Q2N`.
In the Store build the Store does the updates (`process.windowsStore`), and its data is separate.
Listing texts: `deskwisp-store-listing.md` (given to Ossama); pictures in `docs/store/`, `build/appx/`.

**Servers** (after a push that touches `cloud/`, `dcloud/`, `db/` or the site):
```bash
cd /opt/deskwisp && sudo git pull && sudo bash deploy/vps/install.sh
```
Migrations run at the cloud's start. Since the history rewrite the server already did a one-time
`git fetch && git reset --hard origin/main`.

## 6. Where things stand (Oct 25, 2026)

- **App:** 0.1.11 is live on deskwisp.com. 0.1.12 (Deskwisp's name in every user-facing text instead of
  Horafirm) was handed over and may be released by now: check `package.json` and `git log`.
- **Microsoft Store:** submission 1 (0.1.11) in certification, **private audience**, "publish when I
  click Publish now". Next: when it passes, Ossama tests it; then a new submission with the 0.1.12+
  package and **Public audience**; then add a "Get it from Microsoft" badge to the site and README.
- **Legal:** terms and privacy (`deploy/vps/site/terms`, `privacy`) as Ossama wanted: footer "© 2026
  Deskwisp", no company name on the site, the user is responsible for what they give the bots
  (information, files, accounts, numbers, skills, plugins), phone numbers are on the user's own
  AgentPhone account, no disputes clause, no breach-notification clause.
- **Analytics:** off: `POSTHOG_PROJECT` is empty, so no usage events are sent.
- **Done outside the repo:** UptimeRobot, Google Search Console, Clerk production, Polar live, Neon check
  (no bots with the old ids). Left to Ossama: Bing Webmaster Tools (import from Search Console).

## 7. What's next

1. **Store go-live** (above).
2. **Phone app, Android and iPhone from one codebase**, built step by step with Ossama in Claude Code:
   first an APK he tests himself, then Google Play (new personal accounts need **12+ testers opted in to a
   closed test for 14 days in a row** before production), then iPhone once revenue pays the $99 Apple
   year. It talks to `cloud/agent.ts` (works with the PC off) and should look and feel like the Grok app.
   Recruit testers from active Windows users (a Google Group "Deskwisp Android beta"); a "Join the Android
   beta" button on the app's Phone tab (now "Coming soon") was suggested and not done yet.
3. **Marketing, $0 budget, English, worldwide, faceless:** the plan is the doc "Deskwisp Launch Plan"
   (https://claude.ai/artifact/4sS3FoaBTvLvLJuhc462rN): goals (500 sign-ups, 15 Android testers in 6
   weeks), channels (TikTok/Reels/Shorts daily, Reddit, Product Hunt in week 5, Show HN, AI directories,
   X, LinkedIn, Facebook groups), a 30-day calendar, the tester funnel. A starter kit (3 videos, 6 images,
   captions) was made, and a separate **Deskwisp Video Studio** folder (its own `CLAUDE.md`, Remotion,
   voiceover scripts, brand files) is where better videos get made. No fake testimonials, no invented
   numbers; ElevenLabs only on a paid plan (its free plan forbids commercial use); Kokoro or his own voice.

## 8. Things that bite

- `build/` is git-ignored except `build/installer.nsh` (add with `-f`), `build/appx/`, the mac
  entitlements. `dist-win/`, `dist-store/` are ignored and excluded from the type check.
- `release-win.sh` and `release-store.sh` refuse to run with uncommitted changes.
- Don't edit an applied migration; add a new numbered one. The migrator records versions by file name.
- Tests fake the world: the app suites use `registerHooks` stand-ins and fake fetch; quick checks
  (`text.format.name === "answers"`) go to OpenAI when Typesafe isn't set, so fakes must answer or skip them.
- `lib/server/sessions.ts` setup: a computer still asleep at the end of its setup fails the setup (fixed
  Oct 25); keep that guard.
- Never `pkill -f` a pattern that matches your own command; free a port with `fuser -k <port>/tcp`.
- The server's `.env` keys use the `HORAFIRM_` names (`DESKWISP_HORAFIRM_ORIGIN`…) since the rename.
