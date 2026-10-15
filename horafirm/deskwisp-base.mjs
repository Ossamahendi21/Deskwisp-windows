// Build, validate and publish the `deskwisp-base` Horafirm template from files in this repo.
//
// Every Deskwisp computer (Sam's main one and every bot clone) launches from this template:
// Codex for the Agents API executor, the screen MCP, and helpers for per-screen Chrome.
//
// Usage:
//   node horafirm/deskwisp-base.mjs validate
//   node horafirm/deskwisp-base.mjs publish          # publish + build the golden snapshot
//   node horafirm/deskwisp-base.mjs status

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const VERSION = "0.1.8";
const CODEX_VERSION = "0.160.0";
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${root}${p}`, "utf8");

const template = {
  api_version: "deskwisp.com/v1",
  template: {
    name: "deskwisp-base",
    version: VERSION,
    description: "Deskwisp computer: Codex executor, screen MCP, per-screen Chrome, and Tailscale for the mirrored view.",
    publisher: "horafirm",
  },
  // 4:3, boxier than 16:9, like a laptop screen; every screen on the computer matches it.
  hardware: { cpu: 4, ram_gb: 16, resolution: "1280x960x24", auto_stop_minutes: 0 },
  build: {
    apt: [
      "python3.12-venv", "jq", "rsync", "xdotool", "scrot", "hsetroot", "plank", "libglib2.0-bin",
      // Real apps on the bot's computer, so it's a computer and not just a browser.
      "gimp", "inkscape", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "evince", "ristretto", "galculator",
    ],
    run: [
      // Node 24 + npm, matching system/coding.
      "curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/node-setup.sh && bash /tmp/node-setup.sh && apt-get install -y nodejs",
      // Codex, pinned. `codex exec-server` is the Agents API executor.
      `curl -fsSL -o /tmp/codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz && tar -xzf /tmp/codex.tgz -C /tmp && install -m 755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex && codex --version`,
      // Python env for the screen MCP.
      "python3 -m venv /opt/deskwisp/venv && /opt/deskwisp/venv/bin/pip install -q 'mcp==1.26.0'",
      "mkdir -p /workspace/capabilities/skills /root/profiles /root/.deskwisp /var/log/deskwisp /opt/deskwisp/desktop && chmod 700 /root/.deskwisp",
      // Tailscale (userspace networking; joined at runtime by deskwisp-tailnet with a one-use key from Deskwisp).
      "mkdir -p /opt/deskwisp/tailscale && curl -fsSL https://pkgs.tailscale.com/stable/tailscale_latest_amd64.tgz | tar -xz -C /opt/deskwisp/tailscale --strip-components=1 && /opt/deskwisp/tailscale/tailscale version",
    ],
  },
  files: [
    { to: "/opt/deskwisp/screen_mcp.py", inline: read("vm/screen_mcp.py"), mode: "0644" },
    { to: "/usr/local/bin/deskwisp-chrome", inline: read("vm/bin/deskwisp-chrome"), mode: "0755" },
    { to: "/usr/local/bin/deskwisp-seed-profiles", inline: read("vm/bin/deskwisp-seed-profiles"), mode: "0755" },
    { to: "/usr/local/bin/deskwisp-exec", inline: read("vm/bin/deskwisp-exec"), mode: "0755" },
    { to: "/usr/local/bin/deskwisp-tailnet", inline: read("vm/bin/deskwisp-tailnet"), mode: "0755" },
    { to: "/usr/local/bin/deskwisp-screens", inline: read("vm/bin/deskwisp-screens"), mode: "0755" },
    // The bot's own desktop (wallpaper, Chrome theme, home screen, dock); Deskwisp supplies the bot's pages.
    { to: "/usr/local/bin/deskwisp-desktop", inline: read("vm/bin/deskwisp-desktop"), mode: "0755" },
    { to: "/opt/deskwisp/deskwisp-home.py", inline: read("vm/deskwisp-home.py"), mode: "0755" },
  ],
  hooks: {
    on_pre_snapshot: "apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/codex* /tmp/node-setup.sh",
    on_resume: "mkdir -p /root/.deskwisp /var/log/deskwisp && chmod 700 /root/.deskwisp",
  },
};

const key =
  process.env.HORAFIRM_API_KEY ??
  JSON.parse(readFileSync(`${homedir()}/.horafirm/credentials.json`, "utf8")).profiles.default.apiKey;
const api = async (method, path, body) => {
  const res = await fetch(`https://app.deskwisp.com/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
};

const ref = `default/deskwisp-base/${VERSION}`;
const cmd = process.argv[2] ?? "validate";

if (cmd === "validate" || cmd === "publish") {
  const v = await api("POST", "/templates/validate", template);
  if (!v.json.ok) {
    console.error("invalid:", JSON.stringify(v.json.errors ?? v.json, null, 2));
    process.exit(1);
  }
  console.log("valid");
}
if (cmd === "publish") {
  const p = await api("POST", "/templates?auto_build=true&force=true", template);
  console.log(p.status, JSON.stringify(p.json));
}
if (cmd === "status") {
  const s = await api("GET", `/templates/${ref}/build`);
  console.log(s.status, JSON.stringify(s.json));
}
