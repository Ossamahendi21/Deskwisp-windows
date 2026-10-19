# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately, either way:

- On GitHub: the repository's **Security** tab, then **Report a vulnerability**.
- By email: **hello@deskwisp.com**.

Tell us what you found, how to reproduce it, and what it lets someone do. We'll reply within 3 business days and keep you posted until it's fixed. Please give us a reasonable time to fix it before you share it.

## What's in scope

- The Deskwisp server (`app/`, `lib/server/`): anything that lets someone outside your Mac read your state, act as you, or reach your bots' computers.
- The webhook relay (`edge/`) and the webhook routes (`app/api/phone/*`).
- What runs on the bots' computers (`vm/`, `horafirm/`).
- The desktop app (`desktop/`).
- Deskwisp Cloud (`cloud/`, with its schema in `db/`), the server Deskwisp runs at cloud.deskwisp.com/api: anything that lets one user read or act on another user's data, numbers, inboxes or memory, or spend Deskwisp's provider keys.

When you test the hosted service, use your own account, don't touch other people's data, and stop at a proof of concept.

## How Deskwisp is meant to be run

- The server listens on your Mac (port 3210) and trusts requests from it. Don't expose that port to the internet. Only `/hooks/agentphone` and `/hooks/openai` should be public (through `edge/`), and both check signatures.
- Provider keys live in `.env.local`; saved logins live in the Mac's Keychain. Neither is sent to the browser or to models.
- Anyone on your Tailscale tailnet can reach the server: keep the tailnet to your own devices.
- Usage events (PostHog) never carry message, file or screen content, and Deskwisp sends none when self-hosted (see Privacy in the README).
