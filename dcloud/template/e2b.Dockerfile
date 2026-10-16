# A Deskwisp computer: the desktop the bots work on (XFCE, Chrome and real apps), the tools the app
# runs on it (screen MCP, Codex, per-screen Chrome), and what the screens need (Xvfb, x11vnc,
# websockify). The same recipe as Horafirm's deskwisp-base template (horafirm/deskwisp-base.mjs), as a Dockerfile.
# Built into an E2B template by dcloud/template/build.ts; the build context is the repo's root.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=UTC

# The desktop and the screens.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg sudo jq rsync unzip less nano procps psmisc \
      xvfb x11vnc websockify x11-utils x11-xserver-utils xdotool wmctrl scrot imagemagick \
      xfce4 xfce4-terminal xfwm4 xfdesktop4 dbus-x11 hsetroot plank libglib2.0-bin \
      arc-theme papirus-icon-theme fonts-noto fonts-noto-color-emoji fonts-liberation \
      python3 python3-venv python3-pip \
      gimp inkscape libreoffice-writer libreoffice-calc libreoffice-impress evince ristretto galculator \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome, which the bots' screens run (vm/bin/deskwisp-chrome).
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update && apt-get install -y /tmp/chrome.deb && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

# Node 24 and Codex (the Agents API executor), pinned like horafirm/deskwisp-base.mjs.
ARG CODEX_VERSION=0.160.0
RUN curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/node-setup.sh && bash /tmp/node-setup.sh && apt-get install -y nodejs \
    && rm -f /tmp/node-setup.sh && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf /tmp/codex.tgz -C /tmp && install -m 755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex && rm -rf /tmp/codex*

# The screen MCP's Python, and the folders the app writes to.
RUN python3 -m venv /opt/deskwisp/venv && /opt/deskwisp/venv/bin/pip install -q 'mcp==1.26.0' \
    && mkdir -p /workspace/capabilities/skills /root/profiles /root/.deskwisp /var/log/deskwisp /opt/deskwisp/desktop \
    && chmod 700 /root/.deskwisp

# What runs on the computer, from this repo (vm/), and the screens script Deskwisp Cloud also pushes.
COPY vm/screen_mcp.py /opt/deskwisp/screen_mcp.py
COPY vm/deskwisp-home.py /opt/deskwisp/deskwisp-home.py
COPY vm/bin/deskwisp-chrome vm/bin/deskwisp-seed-profiles vm/bin/deskwisp-exec vm/bin/deskwisp-screens vm/bin/deskwisp-desktop vm/bin/deskwisp-reset-screen /usr/local/bin/
# The cloud's own desktop script (dcloud/src/desktop.ts); vm/bin/deskwisp-screens is the app's screen ledger.
COPY dcloud/template/deskwisp-display /usr/local/bin/deskwisp-display
# Windows line endings (a checkout with core.autocrlf) would break these scripts: strip them.
RUN sed -i 's/\r$//' /usr/local/bin/deskwisp-* /opt/deskwisp/*.py \
    && chmod 755 /usr/local/bin/deskwisp-* /opt/deskwisp/deskwisp-home.py

# Chrome as root needs --no-sandbox, which deskwisp-chrome passes; this is where it looks for it.
RUN ln -sf /usr/bin/google-chrome-stable /usr/local/bin/google-chrome

WORKDIR /root
