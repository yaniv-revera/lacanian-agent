import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { emptyLedger, type Ledger } from './types.js';

/**
 * Uses Node's built-in SQLite (`node:sqlite`, Node 22.5+). Deliberately not
 * better-sqlite3: that is a native addon, and every new Node release breaks it
 * until it is rebuilt. Nothing here needs compiling.
 */

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL,
  ledger_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  session_index  INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  ended_by       TEXT,
  gate_latched   INTEGER NOT NULL DEFAULT 0,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL DEFAULT 'ANALYTIC'
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  work        TEXT,
  act         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE TABLE IF NOT EXISTS lockouts (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  until       INTEGER NOT NULL,
  session_id  INTEGER,
  created_at  INTEGER NOT NULL
);
`);

export function now(): number {
  return Date.now();
}

// ---------- users ----------

export function upsertUser(email: string): { id: number; email: string } {
  const existing = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as
    | { id: number; email: string }
    | undefined;
  if (existing) return { id: Number(existing.id), email: String(existing.email) };
  const info = db
    .prepare('INSERT INTO users (email, created_at, ledger_json) VALUES (?, ?, ?)')
    .run(email, now(), JSON.stringify(emptyLedger()));
  return { id: Number(info.lastInsertRowid), email };
}

export function getLedger(userId: number): Ledger {
  const row = db.prepare('SELECT ledger_json FROM users WHERE id = ?').get(userId) as
    | { ledger_json: string }
    | undefined;
  if (!row) return emptyLedger();
  try {
    return { ...emptyLedger(), ...(JSON.parse(String(row.ledger_json)) as Ledger) };
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(userId: number, ledger: Ledger): void {
  db.prepare('UPDATE users SET ledger_json = ? WHERE id = ?').run(JSON.stringify(ledger), userId);
}

// ---------- auth ----------

export function storeLoginCode(email: string, code: string, ttlMs: number): void {
  db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
  db.prepare('INSERT INTO login_codes (email, code, expires_at, used) VALUES (?, ?, ?, 0)').run(
    email,
    code,
    now() + ttlMs,
  );
}

export function consumeLoginCode(email: string, code: string): boolean {
  const row = db
    .prepare('SELECT id, expires_at, used FROM login_codes WHERE email = ? AND code = ?')
    .get(email, code) as { id: number; expires_at: number; used: number } | undefined;
  if (!row || Number(row.used) === 1 || Number(row.expires_at) < now()) return false;
  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

export function createToken(userId: number, token: string): void {
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    now(),
  );
}

export function userIdForToken(token: string): number | null {
  const row = db.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(token) as
    | { user_id: number }
    | undefined;
  return row ? Number(row.user_id) : null;
}

// ---------- lockout ----------

export function lockoutUntil(userId: number): number | null {
  const row = db.prepare('SELECT until FROM lockouts WHERE user_id = ?').get(userId) as
    | { until: number }
    | undefined;
  if (!row) return null;
  const until = Number(row.until);
  if (until <= now()) {
    db.prepare('DELETE FROM lockouts WHERE user_id = ?').run(userId);
    return null;
  }
  return until;
}

export function setLockout(userId: number, until: number, sessionId: number): void {
  db.prepare(
    `INSERT INTO lockouts (user_id, until, session_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET until = excluded.until,
                                        session_id = excluded.session_id,
                                        created_at = excluded.created_at`,
  ).run(userId, until, sessionId, now());
}

export function clearLockout(userId: number): void {
  db.prepare('DELETE FROM lockouts WHERE user_id = ?').run(userId);
}

// ---------- sessions ----------

export interface SessionRow {
  id: number;
  user_id: number;
  session_index: number;
  started_at: number;
  ended_at: number | null;
  ended_by: string | null;
  gate_latched: number;
  turn_count: number;
  mode: string;
}

function asSession(r: Record<string, unknown>): SessionRow {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    session_index: Number(r.session_index),
    started_at: Number(r.started_at),
    ended_at: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
    ended_by: r.ended_by === null || r.ended_by === undefined ? null : String(r.ended_by),
    gate_latched: Number(r.gate_latched),
    turn_count: Number(r.turn_count),
    mode: String(r.mode),
  };
}

export function openSession(userId: number): SessionRow {
  const open = db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(userId) as Record<string, unknown> | undefined;
  if (open) return asSession(open);

  const countRow = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(userId) as {
    c: number;
  };
  const info = db
    .prepare('INSERT INTO sessions (user_id, session_index, started_at) VALUES (?, ?, ?)')
    .run(userId, Number(countRow.c) + 1, now());
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Record<string, unknown>;
  return asSession(row);
}

export function getSession(sessionId: number): SessionRow | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  return row ? asSession(row) : undefined;
}

export function updateSession(
  sessionId: number,
  patch: Partial<Pick<SessionRow, 'gate_latched' | 'turn_count' | 'mode' | 'ended_at' | 'ended_by'>>,
): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
  db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`).run(...values, sessionId);
}

export function appendTurn(
  sessionId: number,
  idx: number,
  role: 'user' | 'analyst',
  text: string,
  work?: string,
  act?: string,
): void {
  db.prepare(
    'INSERT INTO turns (session_id, idx, role, text, work, act, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, idx, role, text, work ?? null, act ?? null, now());
}

export interface TurnRow {
  idx: number;
  role: 'user' | 'analyst';
  text: string;
  act: string | null;
}

export function sessionTurns(sessionId: number): TurnRow[] {
  const rows = db
    .prepare('SELECT idx, role, text, act FROM turns WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    idx: Number(r.idx),
    role: String(r.role) as 'user' | 'analyst',
    text: String(r.text),
    act: r.act === null || r.act === undefined ? null : String(r.act),
  }));
}

export function recentActs(sessionId: number, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT act FROM turns WHERE session_id = ? AND role = 'analyst' AND act IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Record<string, unknown>[];
  return rows.map((r) => String(r.act));
}

/** Full-session count of a given act, not bounded by the recent-acts window. */
export function countAct(sessionId: number, act: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM turns WHERE session_id = ? AND role = 'analyst' AND act = ?`)
    .get(sessionId, act) as { c: number };
  return Number(row.c);
}

/** Full transcript for human review, including the internal work block. */
export function sessionTranscript(sessionId: number): Record<string, unknown>[] {
  return db
    .prepare('SELECT idx, role, text, work, act, created_at FROM turns WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as Record<string, unknown>[];
}
