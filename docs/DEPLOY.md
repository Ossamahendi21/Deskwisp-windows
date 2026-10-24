# Putting Deskwisp on deskwisp.com

Everything runs on one Ubuntu server (an Oracle Cloud VM is enough). The database is Neon, and the
bots' computers are E2B, so neither runs on the server. Caddy in front gets and renews the HTTPS
certificates itself.

| Address | What's there | On the server |
|---|---|---|
| `deskwisp.com` | The website (`deploy/vps/site`) | `/var/www/deskwisp` |
| `app.deskwisp.com` | Accounts and sign-in (Clerk), the bots' computers and their screens, plans, billing (Polar) | `dcloud/`, port 8791 |
| `cloud.deskwisp.com/api` | The services: provider keys, AI credit, the bots' email, calls | `cloud/`, port 8790 |
| `<bot>.<handle>@deskwisp.com` | The bots' email (docs/SERVICES.md "Bots' email") | `cloud/` |

The Windows app goes to `app.deskwisp.com` and `cloud.deskwisp.com/api` by itself (`desktop/win-main.cjs`).
A line in `%APPDATA%\Deskwisp\.env.local` points it elsewhere, such as a server on your own PC:

```
DESKWISP_HORAFIRM_ORIGIN=http://localhost:8791
DESKWISP_CLOUD_URL=http://127.0.0.1:8790
```

## 1. The domain on Cloudflare

Buy `deskwisp.com` anywhere, then add it to Cloudflare (free plan) and set the registrar's nameservers
to the two Cloudflare gives you. Email Routing needs the DNS to be on Cloudflare.

In **DNS → Records**, with the proxy **off** (grey cloud, "DNS only"). Caddy gets the certificates
itself, and Cloudflare's proxy would cut the app's long connections after 100 seconds.

| Type | Name | Content |
|---|---|---|
| A | `@` | the server's public IP |
| A | `app` | the server's public IP |
| A | `cloud` | the server's public IP |
| CNAME | `www` | `deskwisp.com` |
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

Three services add records of their own later, each showing you exactly which:

- **Email Routing** adds its own MX and TXT when you turn it on (step 4).
- **Resend** needs its DKIM record, and an SPF and MX record on `send`.
- **Clerk**'s production instance needs its CNAMEs (`clerk`, `accounts`, `clkmail`, and two `_domainkey`).

## 2. The server

On Oracle Cloud, make an Ubuntu 24.04 VM. Ampere (arm64) and AMD (x64) both work. In its subnet's
**Security List**, add ingress rules for TCP 80 and 443 from `0.0.0.0/0`. Then, on the server:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone -b main https://github.com/Ossamahendi21/Deskwisp-windows.git /opt/deskwisp
sudo bash /opt/deskwisp/deploy/vps/install.sh
```

The repo is private, so `git clone` asks you to sign in. Use a GitHub token with read access, or a
deploy key. `install.sh` sets up the following:

- Node 24, in a folder of its own (`/usr/local/lib/deskwisp-node`). The server's own Node, if it
  has one, isn't touched.
- Caddy, or the one already there. Deskwisp's sites go in `/etc/caddy/deskwisp.caddy`, and the
  Caddyfile gets one line, `import /etc/caddy/deskwisp.caddy`. Every other site in it stays as it
  is, and if Caddy won't take the result, the Caddyfile is put back as it was.
- the two services, on ports 8790 and 8791 on 127.0.0.1 only
- ports 80 and 443 in the machine's own firewall
- `/etc/deskwisp/cloud.env` and `/etc/deskwisp/dcloud.env`, from the examples next to it

Fill in the keys in both files, then run `install.sh` again to start the services:

```bash
sudo nano /etc/deskwisp/cloud.env
sudo nano /etc/deskwisp/dcloud.env
sudo bash /opt/deskwisp/deploy/vps/install.sh
```

**To update** later: `cd /opt/deskwisp && sudo git pull && sudo bash deploy/vps/install.sh`.

**To check:**

```bash
systemctl status deskwisp-cloud deskwisp-dcloud caddy
journalctl -u deskwisp-cloud -f
curl -s https://cloud.deskwisp.com/api/health
```

## 3. The services that need the domain

- **Clerk:** make the production instance, with domain `deskwisp.com`, and add its DNS records. Its
  keys (`pk_live_…`, `sk_live_…`) go in `dcloud.env`. The sign-in page is
  `https://app.deskwisp.com/cli/approve`.
- **Polar:** the webhook is `https://app.deskwisp.com/billing/polar/webhook`, with events
  `order.paid`, `checkout.updated` and every `subscription.*`. Stay on the sandbox until selling is
  cleared (COMMERCIAL-PERMISSION.md).
- **Neon:** for `cloud.env`, use the string without `-pooler`, ending in `sslmode=verify-full`. For
  `dcloud.env`, use the `-pooler` one.
- **Resend:** add `deskwisp.com` and its records, then make an API key with sending access. It goes in
  both files: cloud/ for the bots' mail, dcloud/ for invites.

## 4. The bots' email

Follow docs/SERVICES.md "Bots' email". With the server up, set the Worker's `CLOUD_URL` to
`https://cloud.deskwisp.com/api`. `cloud.env` already has `DESKWISP_MAIL_DOMAIN=deskwisp.com`.

The domain's own addresses (`hello@`, `support@`) can still reach you. In Email Routing, add a rule for
each address, sending it to your own inbox. Those rules come before the catch-all. No bot ever gets
those names.

## 5. New versions of the Windows app

From the repo on your PC (Git Bash), with what's new in it in `docs/releases/v<version>.md` (a few
`- ` lines; up to five show in the app):

```bash
bash scripts/release-win.sh 0.1.0
git push && git push --tags
```

It builds the installer, puts it on the server, checks deskwisp.com serves exactly it, then commits the
new version number and tags it. Every installed Deskwisp asks deskwisp.com within the hour, brings the
new version down in the background, and offers **Restart** in the sidebar and in **About Deskwisp** (the
account menu), where anyone can also **Check for updates** now and turn automatic downloads off.
Restarting shows the update screen while Deskwisp saves, closes and installs; quitting installs it too.
A version downloaded but never installed (Windows shut down first) is offered at the next launch. Your
data stays.

It signs in to the server as set in `.env.release`, at the repo's root (never committed):

```
DESKWISP_SSH=ubuntu@84.8.217.42
DESKWISP_SSH_KEY=D:\Downloads\your-key.key
```

On the server, in `/var/www/deskwisp/download/`:

| File | For |
|---|---|
| `win/latest.json` | the apps: the newest version, its installer, size, SHA-512 and what's new |
| `win/Deskwisp-Setup-<version>-x64.exe` | the apps' downloads (the newest three are kept) |
| `Deskwisp-Setup.exe` | the website's download button: always the newest |

The installer isn't signed yet, so Windows SmartScreen warns on a first install from a browser ("More
info" → "Run anyway"). Updates don't: they come through the app. A code-signing certificate ends the
warning; `electron-builder.win.json` is where it goes.

`bash scripts/release-win.sh --no-publish` only builds, into `dist-win/`.

## 6. Backups and watching

**Backups.** `install.sh` sets up `deskwisp-backup` (deploy/vps/backup.sh), run every night at 03:17 UTC:
the whole database (`db.dump`) and the settings with their keys (`settings.tgz`) go into
`/var/backups/deskwisp/<date>/`, root only, the newest 14 days kept. One now: `sudo deskwisp-backup`. The
last night's run: `sudo cat /var/log/deskwisp-backup.log`.

A copy off the server, from the PC (Git Bash), now and then:

    scp -i <key> -r ubuntu@<server>:/var/backups/deskwisp/<date> /d/Backups/deskwisp/

(the folder is root's: first `sudo cp -r /var/backups/deskwisp/<date> /home/ubuntu/ && sudo chown -R ubuntu /home/ubuntu/<date>`
on the server, then scp from `/home/ubuntu/<date>` and delete it there). Keep it somewhere private: it
holds every customer's data and Deskwisp's keys.

Putting the database back (into a new Neon branch first, to check it):

    pg_restore --clean --if-exists --no-owner -d "<connection string>" db.dump

Neon also keeps its own history: a branch can be restored to a past moment from its console.

**Watching.** A free UptimeRobot account (uptimerobot.com), with three HTTPS monitors every 5 minutes
that email when one is down: `https://deskwisp.com`, `https://app.deskwisp.com/health` and
`https://cloud.deskwisp.com/api/health`. On the server, the services restart themselves if they stop
(systemd), and `sudo journalctl -u deskwisp-dcloud -u deskwisp-cloud -n 100` shows what they said.
