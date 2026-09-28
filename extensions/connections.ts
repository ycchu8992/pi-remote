import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CONFIG_DIR } from "./config.js";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as { lock(path: string, options: object): Promise<() => Promise<void>> };
export const CONNECTION_TTL = 24 * 60 * 60 * 1000;
export const LEASE_TTL = 60_000;
export interface Connection {
  id: string;
  sessionId: string;
  channelId?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  destroyedAt?: number;
  owner?: { id: string; until: number; busy: boolean };
}
interface Registry { version: 1; connections: Connection[]; retiredChannels: string[] }

/** Non-secret registry. All read/modify/write operations use a cross-process lock.
 * Destroyed bindings are tombstones: a channel can never be assigned again.
 * A lease fences duplicate runtimes; a live busy lease temporarily defers expiry.
 */
export class ConnectionStore {
  constructor(readonly path = join(CONFIG_DIR, "connections.json"), private now = Date.now) {}

  private async transaction<T>(fn: (db: Registry, now: number) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false, stale: 30_000, update: 5_000,
      retries: { retries: 60, minTimeout: 25, maxTimeout: 100 },
    });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      let db: Registry;
      try { db = JSON.parse(await readFile(this.path, "utf8")); }
      catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        db = { version: 1, connections: [], retiredChannels: [] };
      }
      if (db?.version !== 1 || !Array.isArray(db.connections) || !Array.isArray(db.retiredChannels) ||
        db.retiredChannels.some(id => typeof id !== "string") || db.connections.some(c =>
          !c || typeof c.id !== "string" || typeof c.sessionId !== "string" ||
          ![c.createdAt, c.lastUsedAt, c.expiresAt].every(Number.isFinite) ||
          (c.channelId !== undefined && typeof c.channelId !== "string") ||
          (c.destroyedAt !== undefined && !Number.isFinite(c.destroyedAt)) ||
          (c.owner !== undefined && (!c.owner || typeof c.owner.id !== "string" || !Number.isFinite(c.owner.until) || typeof c.owner.busy !== "boolean")))) {
        throw new Error("Invalid connection registry; refusing to overwrite it.");
      }
      const ids = db.connections.map(c => c.id);
      const channels = db.connections.flatMap(c => c.channelId ? [c.channelId] : []);
      const sessions = db.connections.filter(c => c.destroyedAt === undefined).map(c => c.sessionId);
      if (new Set(ids).size !== ids.length || new Set(channels).size !== channels.length || new Set(sessions).size !== sessions.length) {
        throw new Error("Conflicting connection ownership in registry; refusing to route events.");
      }
      const now = this.now();
      for (const c of db.connections) {
        if (c.owner && c.owner.until <= now) delete c.owner;
        if (c.destroyedAt === undefined && c.expiresAt <= now && !c.owner?.busy) {
          c.destroyedAt = now;
          delete c.owner;
        }
      }
      const result = fn(db, now);
      await writeFile(temp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });
      await rename(temp, this.path);
      return result;
    } finally {
      await unlink(temp).catch(() => {});
      await release();
    }
  }

  async get(sessionId: string): Promise<Connection | undefined> {
    return this.transaction(db => db.connections.find(c => c.sessionId === sessionId && c.destroyedAt === undefined));
  }

  async enable(sessionId: string): Promise<Connection> {
    return (await this.allocate(sessionId)).connection;
  }

  /** Creation status is decided under the same lock, so rollback never destroys
   * a resource concurrently allocated by a different runtime. */
  async allocate(sessionId: string): Promise<{ connection: Connection; created: boolean }> {
    return this.transaction((db, now) => {
      const existing = db.connections.find(c => c.sessionId === sessionId && c.destroyedAt === undefined);
      if (existing) return { connection: existing, created: false };
      const c: Connection = { id: randomUUID(), sessionId, createdAt: now, lastUsedAt: now, expiresAt: now + CONNECTION_TTL };
      db.connections.push(c);
      return { connection: c, created: true };
    });
  }

  async retireLegacyChannels(channels: string[]): Promise<void> {
    await this.transaction(db => {
      for (const id of channels) if (id && !db.retiredChannels.includes(id)) db.retiredChannels.push(id);
    });
  }

  async claim(sessionId: string, id: string, owner: string): Promise<Connection> {
    return this.transaction((db, now) => {
      const c = this.require(db, sessionId, id);
      if (c.owner && c.owner.id !== owner) throw new Error("This session's connection is owned by another Pi runtime.");
      c.owner = { id: owner, until: now + LEASE_TTL, busy: false };
      return c;
    });
  }

  async heartbeat(sessionId: string, id: string, owner: string, busy: boolean): Promise<Connection> {
    return this.transaction((db, now) => {
      const c = this.requireOwned(db, sessionId, id, owner);
      c.owner = { id: owner, until: now + LEASE_TTL, busy };
      return c;
    });
  }

  async touch(sessionId: string, id: string, owner: string): Promise<Connection> {
    return this.transaction((db, now) => {
      const c = this.requireOwned(db, sessionId, id, owner);
      c.lastUsedAt = now;
      c.expiresAt = now + CONNECTION_TTL;
      c.owner!.until = now + LEASE_TTL;
      return c;
    });
  }

  async bind(sessionId: string, id: string, owner: string, channelId: string): Promise<Connection> {
    return this.transaction(db => {
      const c = this.requireOwned(db, sessionId, id, owner);
      if (c.channelId === channelId) return c;
      if (c.channelId) throw new Error("A connection cannot change its channel.");
      if (db.retiredChannels.includes(channelId) || db.connections.some(other => other.channelId === channelId)) {
        throw new Error("Channel is already bound or permanently retired.");
      }
      c.channelId = channelId;
      return c;
    });
  }

  async disconnect(sessionId: string, id: string, owner: string): Promise<void> {
    await this.transaction(db => {
      const c = db.connections.find(c => c.sessionId === sessionId && c.id === id);
      if (c?.owner?.id === owner) delete c.owner;
    });
  }

  async destroy(sessionId: string, id: string, owner: string): Promise<void> {
    await this.transaction((db, now) => {
      const c = db.connections.find(c => c.sessionId === sessionId && c.id === id);
      if (!c || c.destroyedAt !== undefined) return;
      if (c.owner && c.owner.id !== owner) throw new Error("Connection is owned by another Pi runtime.");
      c.destroyedAt = now;
      delete c.owner;
    });
  }

  private require(db: Registry, sessionId: string, id: string): Connection {
    const c = db.connections.find(c => c.id === id && c.sessionId === sessionId && c.destroyedAt === undefined);
    if (!c) throw new Error("Connection expired or disabled. Run /rc enable, then /rc connect.");
    return c;
  }
  private requireOwned(db: Registry, sessionId: string, id: string, owner: string): Connection {
    const c = this.require(db, sessionId, id);
    if (c.owner?.id !== owner) throw new Error("Connection ownership lost; reconnect from the Pi terminal.");
    return c;
  }
}
