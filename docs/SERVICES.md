# Deskwisp's services: what runs where, and what each costs

Deskwisp users never hold a provider key. Three things run on Deskwisp's server:

| Server | What it does | Settings |
|---|---|---|
| `dcloud/` (port 8791) | Accounts (Clerk sign-in), the bots' computers (E2B), plans, AI credit, computer hours, People | `dcloud/.env` |
| `cloud/` (port 8790) | The services: holds the provider keys, passes the app's calls on, counts each use and takes it from the user's AI credit | `cloud/.env` |
| Honcho (port 8000, optional) | The bots' long-term memory, self-hosted | Honcho's own `.env` |

The app (`.env.local`) only needs to know where the first two are: `DESKWISP_HORAFIRM_ORIGIN` (dcloud) and
`DESKWISP_CLOUD_URL` (cloud), with `DESKWISP_SELF_HOSTED` empty.

Both servers share one Postgres (Neon). dcloud uses the connection string with `-pooler`; cloud/ the
one without it (it holds locks across statements, which Neon's pooler can't keep).

## Plans

| | Free | Pro | Max |
|---|---|---|---|
| Price | $0 | $29 a month | $199 a month |
| AI credit | $1 every month | $10 every month | $100 every month |
| Computer hours | 10 a month | 60 a month | 300 a month |
| Screens per bot | 1 | 2 | 4 |
| Emails for bots | none | 1 | up to 5 |
| People | none | 2 | 5 |

The numbers live in `dcloud/src/plans.ts` and `cloud/protocol.ts` (`DESKWISP_TIERS`): keep the two in
step. AI credit is spent at what each use costs Deskwisp (`cloud/pricing.ts`). A computer (2 vCPU, 4 GB
on E2B) costs about $0.17 an hour while it runs; it sleeps after 15 minutes nobody uses it, and only
the time it runs counts toward the plan's hours.

Which model each plan runs on (cloud/proxy.ts `freeModel`, enforced on the server whatever the app asks):

| | Free | Pro and Max |
|---|---|---|
| Chat, quick checks | gpt-6-luna ($0.10 in, $0.50 out per 1M tokens) | gpt-6.1-sol ($2.00 in, $10.00 out); quick checks on gpt-6-luna |
| Tasks on the computer | gpt-6-luna (`DESKWISP_FREE_TASK_MODEL` to change) | gpt-6.1-sol, gpt-6-astra for hard ones ($10.00 in, $50.00 out) |

When this month's credit is nearly used, the chat says so with Upgrade; when it runs out, the bots stop,
and the tasks it stopped carry on by themselves once there's credit again (an upgrade, or the 1st).

Until billing (Polar) is in, put someone on a plan by hand:

```bash
node --experimental-strip-types --env-file=dcloud/.env dcloud/scripts/set-plan.ts someone@example.com pro
```

## Each provider

| Service | Used for | Cost | Choice |
|---|---|---|---|
| OpenAI | Chat, tasks, voice | Per use | Required. `OPENAI_API_KEY`, plus `OPENAI_EXECUTOR_API_KEY` in a separate project with a monthly budget (it's copied onto the bots' computers) |
| E2B | The bots' computers | ~$0.17/hour running; Hobby is free with $100 once, Pro $150/month | Required (dcloud) |
| Composio | Connected apps (Gmail, Slack…) | Free up to 100K tool calls a month, then $29 | `COMPOSIO_API_KEY` on cloud/ |
| Honcho | Memory | Free self-hosted (AGPL-3.0, unmodified, run as its own service); its own LLM calls default to Gemini (free tier) and OpenAI for embeddings | Optional: `DESKWISP_UPSTREAM_HONCHO`, `HONCHO_API_KEY` |
| Typesafe (Jev) | Quick yes/no checks | $0.042 per 1M tokens, early access | Optional: without it, a small OpenAI call answers instead (`lib/server/decide.ts`); reading the screen on every page change is Jev's alone |
| treg | Business data | Per call, at the provider's price | Optional: `TREG_TOKEN`; paid from the user's AI credit |
| AgentMail | Bots' email | Free: 3 inboxes; $20: 10 with your domain; $200: 150 | Optional: `AGENTMAIL_API_KEY`, `DESKWISP_MAIL_DOMAIN` |
| AgentPhone, Twilio | Phone numbers, texts, calls | $3 a number a month, 13¢ a minute, 2¢ a text; US and Canada only | Off for now |
| Tailscale | — | — | Not needed: dcloud bridges the screens itself |

A service whose key cloud/ doesn't have is shown as off in the app.

## Honcho, self-hosted

```bash
git clone https://github.com/plastic-labs/honcho.git && cd honcho
cp docker-compose.yml.example docker-compose.yml
cp .env.template .env      # LLM keys; AUTH_USE_AUTH=false
docker compose up -d       # http://127.0.0.1:8000
```

With auth off, port 8000 must not be open to the internet: keep it closed in the server's firewall
(only cloud/, on the same machine, calls it). Then in `cloud/.env`: `DESKWISP_UPSTREAM_HONCHO=http://127.0.0.1:8000` and `HONCHO_API_KEY=self-hosted`.
Keep Honcho unmodified and its license notice in place; it runs as a separate service.
