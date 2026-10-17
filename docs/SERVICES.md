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

### Adding AI credit once

On any plan, Settings → Account → Add AI credit buys more: $20, $50, $100, or any whole dollar from $5
to $1,000, at face value. It doesn't expire, and it's spent after the month's plan credit. It's sold
through Polar's checkout (Polar is the merchant of record; no card is kept by Deskwisp), and dcloud adds
it once Polar says it was paid: when the checkout sends the buyer back to dcloud
(`/billing/credit/done`) and when Polar's webhook says so (`/billing/polar/webhook`), once between them.

Set it up in Polar's sandbox first ([sandbox.polar.sh](https://sandbox.polar.sh), test card
4242 4242 4242 4242):

1. Products → New product: **AI credit**, billing **One-time purchase** (never a subscription: dcloud
   won't open a checkout on one), price **Pay what you want** with a $5 minimum. Each checkout sets its
   amount, and the credit added is what was paid in the end.
2. Settings → Developers → New token, with `checkouts:read` and `checkouts:write`.
3. Settings → Webhooks → Add endpoint: `<DESKWISP_PUBLIC_URL>/billing/polar/webhook`, format Raw,
   events `order.paid`, `checkout.updated` and the `subscription.*` events. Without a public address (on a PC) the webhook can't
   reach dcloud; the credit is still added when the checkout sends the buyer back.
4. In `dcloud/.env`: `POLAR_ACCESS_TOKEN`, `POLAR_CREDIT_PRODUCT_ID`, `POLAR_WEBHOOK_SECRET`, then
   restart dcloud.

Real payments need `POLAR_SERVER=production` and `DESKWISP_LIVE_PAYMENTS=1`, which waits for
COMMERCIAL-PERMISSION.md.

### Pro and Max

Upgrade in the app opens Polar's checkout for the plan; once it's paid, the plan, its month of credit
and what it brings (cloud/ hears of it) are in. Someone who already pays gets Polar's customer portal
instead (Upgrade and Manage plan): changing plans, the card, invoices, cancelling. The plan follows the
subscription as Polar has it, read from Polar when the checkout sends the buyer back, when Polar's
webhook says something changed (each month paid, a change of plan, a cancel), and when the app looks at
the plan after its period ended or half an hour went by (so it holds on a PC Polar's webhook can't
reach). Each paid period's credit comes once; an upgrade mid-period adds the rest of the higher plan's.
A cancelled plan runs to the end of its period, then it's Free.

In Polar: two products, **Deskwisp Pro** ($29) and **Deskwisp Max** ($199), Recurring subscription,
monthly, fixed price; their ids in `POLAR_PRO_PRODUCT_ID` and `POLAR_MAX_PRODUCT_ID`. The token needs
`checkouts:read`, `checkouts:write`, `orders:read`, `subscriptions:read`, `subscriptions:write` and
`customer_sessions:write`. Pro to Max from the app opens dcloud's page to confirm it
(`/billing/plan/change`): on Confirm the subscription moves to Max and the difference for the rest of
the period is charged at once; the way down is Manage plan. The webhook
takes `order.paid`, `checkout.updated` and the `subscription.*` events.

Without Polar, put someone on a plan by hand:

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
| Deskwisp Mail (Cloudflare + Resend) | Bots' email | Free past the domain: Cloudflare Email Routing takes mail in at no cost; Resend's free plan sends 3,000 a month, 100 a day | Optional: `RESEND_API_KEY`, `DESKWISP_MAIL_DOMAIN`, `DESKWISP_MAIL_INBOUND_SECRET` ([below](#bots-email)) |
| AgentMail | Bots' email, instead | Free: 3 inboxes in all; $20: 10 with your domain; $200: 150 | Optional: `AGENTMAIL_API_KEY`, `DESKWISP_MAIL_DOMAIN` |
| AgentPhone, Twilio | Phone numbers, texts, calls | $3 a number a month, 13¢ a minute, 2¢ a text; US and Canada only | Off for now |
| Tailscale | — | — | Not needed: dcloud bridges the screens itself |

A service whose key cloud/ doesn't have is shown as off in the app.

## Bots' email

Deskwisp Mail (`cloud/mail.ts`) runs bots' email on cloud/ itself. It costs nothing past the domain.
Mail comes in through Cloudflare Email Routing and goes out through Resend. The app talks to it the
way it talks to AgentMail, so nothing changes on the PC. A bot's address is `<name>.<handle>@<domain>`
(`wispy.tiger@example.com`): Cloudflare's catch-all works on the domain itself, never a subdomain.

You can use a domain whose own mailboxes live somewhere else (`support@`, `hello@`). Cloudflare sends
each of those where its own rule says, and only the rest goes to the bots. Those role names are never
given to a bot.

1. **Cloudflare.** Put the domain's DNS on Cloudflare (free plan). In the domain, open **Email → Email
   Routing**, turn it on, and add the MX and TXT records it asks for.
2. **The Worker.** In **Workers & Pages → Create → Worker**, name it `deskwisp-mail` and paste
   `cloud/deploy/mail-worker.js` into its editor. Deploy it. In its **Settings → Variables and Secrets**,
   add `CLOUD_URL` (your `DESKWISP_CLOUD_PUBLIC_URL`, e.g. `https://cloud.example.com/api`) and the
   secret `INBOUND_SECRET` (`openssl rand -base64 32`).
3. **The catch-all.** Back in **Email Routing → Routing rules**, set **Catch-all address** to
   **Send to a Worker → deskwisp-mail** and turn it on.
4. **Resend.** Make an account and add the same domain under **Domains**. Add the DNS records it
   shows in Cloudflare (DKIM, and SPF and MX on a `send` subdomain, so they don't touch Cloudflare's
   MX). Leave receiving off in Resend: if it offers an MX record for the domain itself, skip that one.
   Wait until it says Verified, then make an API key with **Sending access**.
5. **cloud/.env.** Add `RESEND_API_KEY`, `DESKWISP_MAIL_DOMAIN` (the domain) and
   `DESKWISP_MAIL_INBOUND_SECRET` (the same value as the Worker's `INBOUND_SECRET`). Restart cloud/:
   it logs `Deskwisp Mail is on`.

The Worker has to reach cloud/ over the internet. Until cloud/ is on its server, a quick tunnel works
for a test: `cloudflared tunnel --url http://127.0.0.1:8790`. Put the `https://….trycloudflare.com` it
prints in the Worker's `CLOUD_URL`. The address changes every time the tunnel starts.

Switching from AgentMail moves every user to a new pod at their next session. Bots get new addresses on
the domain, and the old agentmail.to inboxes stop being read. An email the owner sends counts as the
owner only when Cloudflare found that DMARC passed (cloud/mail.ts `dmarcOf`). Otherwise the bot treats it
as anyone else's email.

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
