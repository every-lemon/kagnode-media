import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import type { Policy } from "./types.js";
export const uid = () => crypto.randomUUID(),
  digest = (value: string | Buffer) =>
    crypto.createHash("sha256").update(value).digest("hex");
export const defaultPolicy: Policy = {
  allowInline: true,
  allowDownload: true,
  uploadLimit: 20 * 1024 ** 3,
  creatorQuota: 100 * 1024 ** 3,
  globalQuota: 1024 ** 4,
  registration: true,
  acceleration: "software",
  device: "/dev/dri/renderD128",
  threads: 2,
  concurrency: 1,
  jobTimeout: 14400,
  maxQueuedJobs: 200,
  maxOutputBytes: 40 * 1024 ** 3,
  profiles: [
    { id: "720p", width: 1280, height: 720, bitrate: 2800000 },
    { id: "1080p", width: 1920, height: 1080, bitrate: 5000000 },
  ],
};
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(public config: Config) {
    fs.mkdirSync(config.data, { recursive: true, mode: 0o700 });
    for (const part of ["originals", "uploads", "derived", "jobs", "artwork"])
      fs.mkdirSync(path.join(config.data, part), {
        recursive: true,
        mode: 0o700,
      });
    this.db = new DatabaseSync(path.join(config.data, "media.sqlite3"));
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'viewer',active INTEGER NOT NULL DEFAULT 1,creator_status TEXT NOT NULL DEFAULT 'none',trusted INTEGER NOT NULL DEFAULT 0,quota INTEGER NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS core_notice_receipts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,notice_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,kind TEXT NOT NULL,description TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),draft TEXT,published TEXT,removed INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id),number INTEGER NOT NULL,metadata TEXT NOT NULL,source TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,checksum TEXT NOT NULL,state TEXT NOT NULL,publication TEXT NOT NULL DEFAULT 'draft',derived TEXT NOT NULL DEFAULT '',processing TEXT NOT NULL DEFAULT '{}',created INTEGER NOT NULL,UNIQUE(media_id,number));
  CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),media_id TEXT,version_id TEXT,filename TEXT NOT NULL,size INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'open',lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),state TEXT NOT NULL DEFAULT 'queued',progress REAL NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,cancel INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(state,created);
  CREATE TABLE IF NOT EXISTS favorites(user_id TEXT NOT NULL REFERENCES users(id),media_id TEXT NOT NULL REFERENCES media(id),PRIMARY KEY(user_id,media_id));
  CREATE TABLE IF NOT EXISTS progress(user_id TEXT NOT NULL REFERENCES users(id),media_id TEXT NOT NULL REFERENCES media(id),position REAL NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(user_id,media_id));
  CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id),author TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT NOT NULL,target TEXT,detail TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),actor TEXT NOT NULL REFERENCES users(id),outcome TEXT NOT NULL,note TEXT NOT NULL,created INTEGER NOT NULL);
  `);
    fs.chmodSync(path.join(config.data, "media.sqlite3"), 0o600);
  }
  one(sql: string, ...p: any[]): any {
    return this.db.prepare(sql).get(...p);
  }
  all(sql: string, ...p: any[]): any[] {
    return this.db.prepare(sql).all(...p) as any[];
  }
  run(sql: string, ...p: any[]) {
    return this.db.prepare(sql).run(...p);
  }
  transaction<T>(fn: () => T): T {
    const n = this.depth++,
      key = "media_" + n;
    let started = false;
    try {
      this.db.exec(n ? "SAVEPOINT " + key : "BEGIN IMMEDIATE");
      started = true;
      const result = fn();
      if (result && typeof (result as any).then === "function")
        throw Error("Transactions must be synchronous.");
      this.db.exec(n ? "RELEASE SAVEPOINT " + key : "COMMIT");
      return result;
    } catch (e) {
      if (started) {
        this.db.exec(n ? "ROLLBACK TO SAVEPOINT " + key : "ROLLBACK");
        if (n) this.db.exec("RELEASE SAVEPOINT " + key);
      }
      throw e;
    } finally {
      this.depth--;
    }
  }
  policy(): Policy {
    const value = this.one("SELECT value FROM settings WHERE key='policy'");
    return value
      ? { ...defaultPolicy, ...JSON.parse(value.value) }
      : structuredClone(defaultPolicy);
  }
  audit(
    actor: string | null,
    action: string,
    target: string,
    detail: unknown = {},
  ) {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?)",
      uid(),
      actor,
      action,
      target,
      JSON.stringify(detail),
      Date.now(),
    );
  }
  user(id: string) {
    return this.one("SELECT * FROM users WHERE id=? AND active=1", id);
  }
  close() {
    this.db.close();
  }
}
