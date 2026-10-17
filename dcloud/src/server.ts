import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { Computers, HttpError, readBody } from "./computers.ts";
import { loadConfig, type Config } from "./config.ts";
import { E2BProvider } from "./providers/e2b.ts";
import { LocalProvider } from "./providers/local.ts";
import type { Provider } from "./providers/types.ts";
import { Accounts } from "./accounts.ts";
import { clerkVerifier, type Verifier } from "./clerk.ts";
import { JsonStore, type Store } from "./store.ts";
import { PgStore } from "./store-pg.ts";
import { Billing } from "./billing.ts";
import { isTier } from "./plans.ts";
import { People } from "./people.ts";

/**
 * Deskwisp Cloud: the app's sign-in (accounts.ts, with Clerk), its users, keys and computers (in Neon,
 * store-pg.ts), and the bots' computers themselves (computers.ts), at the paths the app calls on Horafirm
 * (DESKWISP_HORAFIRM_ORIGIN=<this server>), with the live view's WebSocket at /desktops/<id>/ws/websockify.
 *
 *   node dcloud/src/server.ts
 */

export function makeProvider(cfg: Config): Provider {
  if (cfg.provider === "local") return new LocalProvider(join(cfg.dataDir, "boxes"));
  return new E2BProvider({ apiKey: cfg.e2bApiKey!, template: cfg.e2bTemplate, idleMs: cfg.idleMs });
}

export async function openStore(cfg: Config): Promise<Store> {
  return cfg.databaseUrl ? PgStore.open(cfg.databaseUrl) : new JsonStore(join(cfg.dataDir, "store.json"));
}

export function makeVerifier(cfg: Config): Verifier | null {
  if (!cfg.clerkSecretKey) return null;
  // Clerk names the page a session token was made on (azp): only this server's own sign-in page counts.
  const own = new URL(cfg.publicUrl).origin;
  const parties = [own, own.replace("//localhost", "//127.0.0.1"), own.replace("//127.0.0.1", "//localhost")];
  return clerkVerifier({ secretKey: cfg.clerkSecretKey, authorizedParties: [...new Set(parties)] });
}

export async function startServer(
  cfg: Config,
  opts: {
    provider?: Provider;
    store?: Store;
    verifier?: Verifier | null;
    accounts?: ConstructorParameters<typeof Accounts>[3];
    people?: ConstructorParameters<typeof People>[5];
  } = {},
) {
  const provider = opts.provider ?? makeProvider(cfg);
  const store = opts.store ?? (await openStore(cfg));
  const verifier = opts.verifier !== undefined ? opts.verifier : makeVerifier(cfg);
  const accounts = new Accounts(cfg, store, verifier, opts.accounts);
  // A signed-in user's plan; a development key (DESKWISP_API_KEYS) is on DESKWISP_DEV_PLAN, Max unless set.
  const devPlan = isTier(process.env.DESKWISP_DEV_PLAN) ? process.env.DESKWISP_DEV_PLAN : "max_deskwisp";
  const planOf = async (owner: string) => (await store.user(owner).catch(() => null))?.plan ?? devPlan;
  const computers = new Computers(cfg, store, provider, planOf);
  const people = new People(cfg, store, computers, verifier, planOf, opts.people);
  const billing = new Billing(cfg, store, computers, planOf);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dcloud");
    try {
      if (url.pathname === "/health") return send(res, 200, { ok: true, provider: provider.name, store: store.kind, signIn: !!cfg.clerkSecretKey });
      let body: Promise<unknown> | undefined;
      const readOnce = () => (body ??= readBody(req));
      // First: Polar's webhook is checked against its body as it came.
      if (await billing.public(req, res, url)) return;
      if (await accounts.public(req, res, url, readOnce, (status, out) => send(res, status, out))) return;
      if (await people.public(req, res, url, readOnce, (status, out) => send(res, status, out))) return;
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found", "not_found");
      const owner = await accounts.ownerOf(req);
      if (!owner) {
        // Say why, without the key itself: only its length and last 4 characters, to compare by eye.
        const sent = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1].trim();
        console.warn(
          `[dcloud] 401 ${req.method} ${url.pathname}: ` +
            (sent ? `the key sent (${sent.length} chars, ending …${sent.slice(-4)}) isn't one of this server's` : "no key sent (sign in from the app)"),
        );
        throw new HttpError(401, "Unauthorized", "unauthorized");
      }
      const parts = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.join("/") === "user/profile" && req.method === "GET") return send(res, 200, await accounts.profile(owner));
      const billed = await billing.handle(owner, (req.method ?? "GET").toUpperCase(), parts, readOnce);
      if (billed !== false) return send(res, 200, billed);
      const shared = await people.handle(owner, (req.method ?? "GET").toUpperCase(), parts, readOnce);
      if (shared !== false) return send(res, 200, shared);
      const out = await computers.handle({
        owner,
        method: (req.method ?? "GET").toUpperCase(),
        parts,
        query: url.searchParams,
        body: readOnce,
        res,
      });
      if (out === false) throw new HttpError(404, "Not found", "not_found");
      if (out !== undefined) send(res, 200, out);
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      const err =
        e instanceof HttpError ? e : typeof status === "number" && status >= 400 && status < 500 ? new HttpError(status, (e as Error).message) : new HttpError(500, (e as Error)?.message ?? "error", "internal");
      if (err.status >= 500) console.warn(`[dcloud] ${req.method} ${url.pathname}: ${err.message}`);
      send(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}), ...((err as { extra?: object }).extra ?? {}) });
    }
  });

  // The live view: the app's noVNC opens /desktops/<id>/ws/websockify?token=<vnc password>[&screen=<id>],
  // and it's piped to that screen's websockify bridge inside the computer. The watch page (people.ts)
  // comes with ?ticket= instead: someone signed in, allowed to see that computer for now.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false) });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://dcloud");
    const m = /^\/desktops\/([^/]+)\/ws\/websockify$/.exec(url.pathname);
    const ticket = url.searchParams.get("ticket");
    const id = m ? decodeURIComponent(m[1]) : "";
    const viewer = m && ticket ? await people.bridge(ticket, id, url.searchParams.get("screen")).catch(() => null) : null;
    const target = ticket ? viewer : m ? await computers.bridge(id, url.searchParams.get("token") ?? "", url.searchParams.get("screen")).catch(() => null) : null;
    if (!target) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(target.url, ["binary"]);
      const pending: Buffer[] = [];
      client.on("message", (data: Buffer) => {
        // Someone at the live view keeps the computer awake (computers.touch tells the provider once a minute at most).
        computers.touch(target.boxId);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        else pending.push(data);
      });
      upstream.on("open", () => {
        for (const d of pending.splice(0)) upstream.send(d);
      });
      upstream.on("message", (data: Buffer) => client.readyState === WebSocket.OPEN && client.send(data));
      const close = () => {
        client.close();
        upstream.close();
      };
      // A watcher's view ends when their access changes (people.ts).
      const forget = viewer?.opened(close);
      client.on("close", () => (close(), forget?.()));
      upstream.on("close", close);
      upstream.on("error", close);
      client.on("error", close);
    });
  });

  server.on("close", () => {
    computers.stop();
    void store.close().catch(() => {});
  });
  server.listen(cfg.port, cfg.host);
  return { server, store, accounts, computers, people, billing };
}

// Run directly (not imported by the tests). Node 24 says so in import.meta.main; on 22, compare paths,
// case-blind for Windows ("file://" + argv[1] never matched a Windows path, so the server didn't start).
const isMain =
  (import.meta as { main?: boolean }).main ??
  (!!process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase());
if (isMain) {
  const cfg = loadConfig();
  const fail = (e: Error) => {
    console.error(`Deskwisp Cloud couldn't start: ${e.message}`);
    if (/password authentication failed|role .* does not exist/.test(e.message))
      console.error("Check DATABASE_URL in dcloud/.env: copy it again from Neon (your project → Connect), with its password.");
    process.exit(1);
  };
  startServer(cfg).then(({ server, store }) => {
    server.on("listening", () => {
      console.log(`Deskwisp Cloud on http://${cfg.host}:${cfg.port} (computers on ${cfg.provider})`);
      console.log(`Accounts in ${store.kind === "postgres" ? "Postgres (DATABASE_URL)" : "a JSON file (no DATABASE_URL)"}`);
      console.log(
        cfg.clerkSecretKey && cfg.clerkPublishableKey
          ? `Sign-in with Clerk: ${cfg.publicUrl}/cli/approve`
          : "Sign-in is off: set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in dcloud/.env.",
      );
      const keys = [...cfg.apiKeys.keys()].map((k) => `${k.length} chars, ending …${k.slice(-4)}`);
      if (keys.length) console.log(`Development keys (DESKWISP_API_KEYS): ${keys.join("; ")}`);
    });
    server.on("error", fail);
  }, fail);
}
