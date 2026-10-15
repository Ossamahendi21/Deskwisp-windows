import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Computers, HttpError, readBody } from "./computers.ts";
import { loadConfig, type Config } from "./config.ts";
import { E2BProvider } from "./providers/e2b.ts";
import { LocalProvider } from "./providers/local.ts";
import type { Provider } from "./providers/types.ts";
import { Registry } from "./registry.ts";

/**
 * Deskwisp Cloud. Step 2.1: the bots' computers, at the paths the app calls on Horafirm
 * (DESKWISP_HORAFIRM_ORIGIN=<this server>), and the live view's WebSocket at /desktops/<id>/ws/websockify.
 *
 *   node dcloud/src/server.ts
 */

export function makeProvider(cfg: Config): Provider {
  if (cfg.provider === "local") return new LocalProvider(join(cfg.dataDir, "boxes"));
  return new E2BProvider({ apiKey: cfg.e2bApiKey!, template: cfg.e2bTemplate, idleMs: cfg.idleMs });
}

export function startServer(cfg: Config, provider: Provider = makeProvider(cfg)) {
  const registry = new Registry(join(cfg.dataDir, "registry.json"));
  const computers = new Computers(cfg, registry, provider);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const ownerOf = (req: IncomingMessage) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return m ? (cfg.apiKeys.get(m[1].trim()) ?? null) : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dcloud");
    try {
      if (url.pathname === "/health") return send(res, 200, { ok: true, provider: provider.name });
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found", "not_found");
      const owner = ownerOf(req);
      if (!owner) throw new HttpError(401, "Unauthorized", "unauthorized");
      const parts = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
      let body: Promise<unknown> | undefined;
      const out = await computers.handle({
        owner,
        method: (req.method ?? "GET").toUpperCase(),
        parts,
        query: url.searchParams,
        body: () => (body ??= readBody(req)),
        res,
      });
      if (out === false) throw new HttpError(404, "Not found", "not_found");
      if (out !== undefined) send(res, 200, out);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error)?.message ?? "error", "internal");
      if (err.status >= 500) console.warn(`[dcloud] ${req.method} ${url.pathname}: ${err.message}`);
      send(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  });

  // The live view: the app's noVNC opens /desktops/<id>/ws/websockify?token=<vnc password>[&screen=<id>],
  // and it's piped to that screen's websockify bridge inside the computer.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false) });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://dcloud");
    const m = /^\/desktops\/([^/]+)\/ws\/websockify$/.exec(url.pathname);
    const target = m ? await computers.bridge(decodeURIComponent(m[1]), url.searchParams.get("token") ?? "", url.searchParams.get("screen")).catch(() => null) : null;
    if (!target) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(target, ["binary"]);
      const pending: Buffer[] = [];
      client.on("message", (data: Buffer) => (upstream.readyState === WebSocket.OPEN ? upstream.send(data) : pending.push(data)));
      upstream.on("open", () => {
        for (const d of pending.splice(0)) upstream.send(d);
      });
      upstream.on("message", (data: Buffer) => client.readyState === WebSocket.OPEN && client.send(data));
      const close = () => {
        client.close();
        upstream.close();
      };
      client.on("close", close);
      upstream.on("close", close);
      upstream.on("error", close);
      client.on("error", close);
    });
  });

  server.listen(cfg.port, cfg.host);
  return { server, registry, computers };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { server } = startServer(cfg);
  server.on("listening", () => console.log(`Deskwisp Cloud on http://${cfg.host}:${cfg.port} (computers on ${cfg.provider})`));
}
