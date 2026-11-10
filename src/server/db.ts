/**
 * db.ts — SQLite storage (Node's built-in driver; no native dependency).
 *
 * Revisions, reviews, approvals and audit entries are insert-only. Nothing in
 * the server updates or deletes them.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { canonicalJson } from "../kernel/approval";

// Loaded through require so bundlers and test runners leave the built-in alone.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncType;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  imported_by TEXT NOT NULL REFERENCES users(id),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  rev INTEGER NOT NULL,
  plan TEXT NOT NULL,
  dataset TEXT,
  inputs_hash TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, rev)
);
CREATE TABLE IF NOT EXISTS reviews (
  revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
  approver_id TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL,
  scope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

const GENESIS = "0".repeat(64);

function entryHash(prev: string, at: string, userId: string | null, action: string, detail: string): string {
  return createHash("sha256").update(prev).update(canonicalJson({ at, userId, action, detail })).digest("hex");
}

/** Append to the hash-chained audit log. */
export function audit(db: Db, userId: string | null, action: string, detail: Record<string, unknown>): void {
  const last = db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const text = canonicalJson(detail);
  db.prepare("INSERT INTO audit (at, user_id, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)").run(at, userId, action, text, prev, entryHash(prev, at, userId, action, text));
}

/** Recompute the chain. Returns the first sequence number that does not verify, or null if intact. */
export function verifyAudit(db: Db): number | null {
  const rows = db.prepare("SELECT seq, at, user_id, action, detail, prev_hash, hash FROM audit ORDER BY seq").all() as Array<{
    seq: number;
    at: string;
    user_id: string | null;
    action: string;
    detail: string;
    prev_hash: string;
    hash: string;
  }>;
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== entryHash(prev, r.at, r.user_id, r.action, r.detail)) return r.seq;
    prev = r.hash;
  }
  return null;
}
