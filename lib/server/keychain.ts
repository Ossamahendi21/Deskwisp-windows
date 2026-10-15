import "server-only";
import { execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateUser } from "./store";
import { dataRoot } from "./user-paths";
import { ON_MAC, ON_WINDOWS } from "./platform";

/**
 * Secrets, under "Deskwisp Vault".
 *
 * - On a Mac: the Keychain. Values go to `security` on stdin, hex-encoded, so they never show up in
 *   the process list; reading one back only names the item.
 * - Elsewhere (Windows, Linux): an AES-256-GCM sealed file, .data/vault.sealed. Its key is made once
 *   and kept beside it: on Windows sealed with DPAPI for this Windows user (vault.key.dpapi, readable
 *   only by this user on this PC), on Linux in vault.key with mode 0600, or DESKWISP_VAULT_KEY (base64, 32
 *   bytes) when set. Secrets are read into memory once and never leave this process.
 */
const SERVICE = "Deskwisp Vault";
const MAC = ON_MAC;

// ---------------------------------------------------------------- Mac Keychain

const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

function macSet(account: string, value: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain refused it: ${err.trim() || code}`))));
    p.stdin.end(`add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
  });
}

const macGet = (account: string) =>
  new Promise<string | null>((resolve) =>
    execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], (e, out) => resolve(e ? null : out.replace(/\n$/, ""))),
  );

const macDelete = (account: string) =>
  new Promise<void>((resolve) => execFile("security", ["delete-generic-password", "-s", SERVICE, "-a", account], () => resolve()));

// ---------------------------------------------------------------- Sealed file (Windows, Linux)

const vaultFile = () => join(dataRoot(), "vault.sealed");

/** Runs a short PowerShell script with `input` on stdin, and gives back what it printed. */
function powershell(script: string, input: string) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`DPAPI: ${err.trim() || `exit ${code}`}`))));
    p.stdin.end(input);
  });
}

// DPAPI for the current Windows user. The key goes in and out as base64 on stdin/stdout, never on a command line.
const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const DPAPI_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

function writeAtomic(file: string, data: string, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
  if (!ON_WINDOWS) chmodSync(file, mode);
}

/** The vault's key: made the first time, then the same one. */
async function makeOrReadKey(): Promise<Buffer> {
  const fromEnv = process.env.DESKWISP_VAULT_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv, "base64");
    if (k.length !== 32) throw new Error("DESKWISP_VAULT_KEY must be 32 bytes, base64");
    return k;
  }
  if (ON_WINDOWS) {
    const file = join(dataRoot(), "vault.key.dpapi");
    if (existsSync(file)) return Buffer.from(await powershell(DPAPI_UNPROTECT, readFileSync(file, "utf8")), "base64");
    const k = randomBytes(32);
    writeAtomic(file, await powershell(DPAPI_PROTECT, k.toString("base64")));
    return k;
  }
  const file = join(dataRoot(), "vault.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const k = randomBytes(32);
  writeAtomic(file, k.toString("base64"));
  return k;
}

type Vault = { key: Buffer; items: Map<string, string> };
let vaultPromise: Promise<Vault> | null = null;
/** One change at a time, so two saves never race on the file. */
let writing: Promise<unknown> = Promise.resolve();

function openVault() {
  vaultPromise ??= (async () => {
    const key = await makeOrReadKey();
    const items = new Map<string, string>();
    if (existsSync(vaultFile())) {
      const raw = Buffer.from(readFileSync(vaultFile(), "utf8").trim(), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
      for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, string>)) items.set(k, v);
    }
    return { key, items };
  })().catch((e) => {
    vaultPromise = null;
    throw e;
  });
  return vaultPromise;
}

function saveVault(v: Vault) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", v.key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(v.items)), "utf8"), c.final()]);
  writeAtomic(vaultFile(), Buffer.concat([iv, c.getAuthTag(), body]).toString("base64"));
}

function change(fn: (v: Vault) => void) {
  const next = writing.then(async () => {
    const v = await openVault();
    fn(v);
    saveVault(v);
  });
  writing = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------- The API everyone uses

export function setSecret(account: string, value: string): Promise<void> {
  if (MAC) return macSet(account, value);
  return change((v) => void v.items.set(account, value)).catch((e) => {
    throw new Error(`The vault refused it: ${e instanceof Error ? e.message : e}`);
  });
}

export async function getSecret(account: string): Promise<string | null> {
  if (MAC) return macGet(account);
  try {
    return (await openVault()).items.get(account) ?? null;
  } catch {
    return null;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  if (MAC) return macDelete(account);
  await change((v) => void v.items.delete(account)).catch(() => {});
}

/*
 * A user's own secrets (a vault login's password and 2FA key, a channel's token): named for the
 * signed-in Horafirm user, so another account signed in on this computer never reaches them. Their state
 * lists them (the vault, the channels), and each user's state is their own. A secret saved before
 * names had a user is still read for the user whose state names it, and moved to their name.
 */
const forUser = (name: string) => {
  const user = stateUser();
  return user ? `${user}:${name}` : name;
};

export async function getUserSecret(name: string) {
  const named = forUser(name);
  const value = await getSecret(named);
  if (value !== null || named === name) return value;
  const old = await getSecret(name);
  if (old !== null)
    await setSecret(named, old)
      .then(() => deleteSecret(name))
      .catch(() => {});
  return old;
}

export const setUserSecret = (name: string, value: string) => setSecret(forUser(name), value);

export async function deleteUserSecret(name: string) {
  const named = forUser(name);
  await deleteSecret(named);
  if (named !== name) await deleteSecret(name);
}
