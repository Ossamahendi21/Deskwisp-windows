<p align="center">
  <b>Deskwisp</b><br>
  A team of AI bots that does your business ops on real computers, on Windows.<br>
  Chat with them like teammates, from your PC or your phone, and they get the work done.
</p>

---

Deskwisp gives you a team of AI bots for the work that keeps a small business running: the inbox, leads and the pipeline, invoices, reports. Each bot works on its own cloud computer, which you can watch live and take over at any time. They remember who you are and what they did yesterday, and they ask before they send, create or pay anything.

> Personal build. This copy is for my own use on Windows and Android. It is not a product and is not offered to anyone else.

## What the bots can do

- **Work on real computers.** Each bot works on a cloud computer with several screens and a browser. Watch any screen live, take control, then hand it back.
- **Work as a team.** A main bot runs the team and hands work to the specialist bots you add. They talk to each other and report back in the chat.
- **Remember.** What you tell your bots, they remember, per workspace, on every channel.
- **Use your apps.** Connect Gmail, Calendar and many other apps. Reading runs at once; sending, creating or paying asks you first.
- **Reach you on your phone.** Add a bot to Telegram or Discord and give it work from Android or iPhone. It answers when it's mentioned and takes requests only from you.
- **Sign in safely.** Saved logins live in an encrypted vault on your PC. No model ever sees them.
- **Keep an eye on things.** Routines and reminders run on a schedule, and a bot can watch a screen and tell you when something needs you.

## Install on Windows

1. Run the installer from `dist-win\` (or join the downloaded parts with `join-deskwisp.bat` first).
2. The build isn't signed, so Windows SmartScreen asks once: **More info → Run anyway**.
3. Open the app and sign in.

Your data stays in `%APPDATA%\Deskwisp`:

| Path | What's there |
|---|---|
| `data\` | The app's state and the encrypted vault (`vault.sealed`) |
| `data\vault.key.dpapi` | The vault's key, sealed with Windows DPAPI for your Windows user only |
| `.env.local` | Your own settings and keys, one `KEY=value` per line (optional) |
| `logs\` | `main.log` and `server.log`, for when something goes wrong |

## Build from source

Requirements: Windows 10/11 x64, Node 22 or newer, Git Bash.

```bash
npm ci
npm run app:win            # run from the source folder (next dev)
npm run app:win:release    # build dist-win/Deskwisp-Setup-<version>-x64.exe
```

The build script compiles the server, keeps only what it needs, checks that it starts with no keys, and packs it with Electron into an NSIS installer.

## Running on your own keys

Put settings in `%APPDATA%\Deskwisp\.env.local`. `.env.example` lists every setting with a note on each. The ones that matter most:

| Setting | What it's for |
|---|---|
| `DESKWISP_SELF_HOSTED=1` | Call each provider directly with your own keys |
| `OPENAI_API_KEY` | Chat, calls, and tasks on the bots' computers |
| `OPENAI_EXECUTOR_API_KEY` | A second, restricted key with a spend limit, for the bots' tools |
| `HORAFIRM_API_KEY` | The bots' cloud computers |
| `DESKWISP_HORAFIRM_ORIGIN` | Point the bots' computers at another server with the same API |
| `DESKWISP_CHROME` | Path to `chrome.exe`, if it isn't found on its own |
| `DESKWISP_DATA_DIR` | Keep the app's data somewhere else |

## What changed for Windows

- **Vault:** secrets are sealed with AES-256-GCM in a file, with its key sealed by Windows DPAPI.
- **Platform:** the server reads the platform when it starts, not when it's built (the build had baked in the build machine's platform).
- **Desktop shell:** `desktop/win-main.cjs` starts the server with Electron's own Node, keeps data in `%APPDATA%`, and puts Windows' own window buttons over the title bar.
- **Your PC's Chrome:** the bots' local Chrome is found on Windows, and links open in your default browser.
- **Offline build:** fonts come from the `geist` package instead of Google Fonts.
- Tasks that run directly in a shell on your PC are still off: they were written for another system.

## Security

- The local server trusts requests from this PC. Don't expose port 3210 to the internet; for remote access use Telegram/Discord or a private network such as Tailscale.
- Keys never go to the window or to a model.

## Credits and license

Deskwisp is a personal modified copy of [Deskwisp](https://github.com/Horafirm/deskwisp) by Nick Vasilescu and Organic Intelligence, Inc. (v0.0.28), used under the [Functional Source License 1.1, ALv2 Future License](LICENSE). The license allows using and changing it for personal and internal use, and does not allow offering it as a competing product or hosted service. "Deskwisp" and its logo and mascots are trademarks of Organic Intelligence, Inc.; this copy is not affiliated with or endorsed by them. Code in `components/message-ui/` is adapted from imessage-ui (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
