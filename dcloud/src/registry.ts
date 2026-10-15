import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Who owns which computer, in one JSON file. Enough for one server and a few hundred users; the
 * accounts step (Neon) moves this into Postgres behind the same functions.
 */

export type Computer = {
  id: string;
  owner: string;
  workspaceId: string;
  name: string;
  /** The provider's id for the box. */
  boxId: string;
  provider: string;
  /** Opens the live view (the app passes it as ?token=). */
  vncPassword: string;
  cpu: number;
  ram: number;
  createdAt: number;
};

export type Workspace = { id: string; owner: string; name: string; createdAt: number };

type Data = { computers: Computer[]; workspaces: Workspace[] };

export class Registry {
  private readonly file: string;
  private data: Data;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Data) : { computers: [], workspaces: [] };
  }

  private save() {
    const tmp = `${this.file}.${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  workspaces(owner: string) {
    return this.data.workspaces.filter((w) => w.owner === owner);
  }

  addWorkspace(owner: string, name: string): Workspace {
    const taken = this.workspaces(owner).find((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (taken) throw Object.assign(new Error("a workspace with that name exists"), { status: 409 });
    const w = { id: randomUUID(), owner, name, createdAt: Date.now() };
    this.data.workspaces.push(w);
    this.save();
    return w;
  }

  workspace(owner: string, id: string) {
    return this.data.workspaces.find((w) => w.owner === owner && w.id === id) ?? null;
  }

  computers(owner: string, workspaceId?: string) {
    return this.data.computers.filter((c) => c.owner === owner && (!workspaceId || c.workspaceId === workspaceId));
  }

  computer(owner: string, id: string) {
    return this.data.computers.find((c) => c.owner === owner && c.id === id) ?? null;
  }

  /** Any owner's computer by id, for the live view (its VNC password is the check there). */
  anyComputer(id: string) {
    return this.data.computers.find((c) => c.id === id) ?? null;
  }

  addComputer(c: Omit<Computer, "id" | "createdAt" | "vncPassword">): Computer {
    // VNC passwords are at most 8 characters.
    const full: Computer = { ...c, id: randomUUID(), createdAt: Date.now(), vncPassword: randomBytes(6).toString("base64url").slice(0, 8) };
    this.data.computers.push(full);
    this.save();
    return full;
  }

  removeComputer(id: string) {
    this.data.computers = this.data.computers.filter((c) => c.id !== id);
    this.save();
  }
}
