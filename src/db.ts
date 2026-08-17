import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { emptyLedger, type Ledger } from './types.js';
import { evaluateAuthToken, evaluateLoginCode, type LoginCodeVerifyResult } from './agent/security.js';

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
  used        INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- created_at doubles as issued_at: a token is never re-issued in place,
-- only deleted (logout) or replaced by a fresh row from a new login.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);

-- per-(scope, key) event log backing fixed-window rate limits. key is
-- an email or an IP address depending on scope; never both in the same row.
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_scope_key ON rate_limit_events(scope, key, created_at);

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

/**
 * The row is fetched by email alone — never `WHERE code = ?` — so the code
 * comparison itself happens in JS via `evaluateLoginCode`'s constant-time
 * check, not in SQLite, which would short-circuit on the first mismatched
 * byte and leak timing. See `evaluateLoginCode` for why `bad` covers every
 * rejection reason except the attempt ceiling.
 */
export function consumeLoginCode(email: string, code: string, maxAttempts: number): LoginCodeVerifyResult {
  const row = db
    .prepare('SELECT id, code, expires_at, used, attempts FROM login_codes WHERE email = ?')
    .get(email) as
    | { id: number; code: string; expires_at: number; used: number; attempts: number }
    | undefined;

  const verdict = evaluateLoginCode(
    row
      ? {
          code: String(row.code),
          expiresAt: Number(row.expires_at),
          used: Number(row.used) === 1,
          attempts: Number(row.attempts),
        }
      : undefined,
    code,
    now(),
    maxAttempts,
  );

  if (row && verdict.incrementAttempt) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  }
  if (row && verdict.result === 'ok') {
    db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  }
  return verdict.result;
}

export function createToken(userId: number, token: string, ttlMs: number): void {
  const t = now();
  db.prepare(
    'INSERT INTO auth_tokens (token, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run(token, userId, t, t + ttlMs, t);
}

/** Rejects (and does not touch) an expired token; otherwise stamps last_used_at. */
export function userIdForToken(token: string): number | null {
  const row = db.prepare('SELECT user_id, expires_at FROM auth_tokens WHERE token = ?').get(token) as
    | { user_id: number; expires_at: number }
    | undefined;
  const verdict = evaluateAuthToken(
    row ? { userId: Number(row.user_id), expiresAt: Number(row.expires_at) } : undefined,
    now(),
  );
  if (!verdict.valid) return null;
  db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token = ?').run(now(), token);
  return verdict.userId;
}

/** Server-side logout: the token row is gone, not merely marked. */
export function deleteToken(token: string): void {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

// ---------- rate limiting ----------

/** Timestamps for `scope`+`key` events newer than `sinceMs` ago, for `checkRateLimit`. */
export function rateLimitTimestamps(scope: string, key: string, sinceMs: number): number[] {
  const rows = db
    .prepare('SELECT created_at FROM rate_limit_events WHERE scope = ? AND key = ? AND created_at > ?')
    .all(scope, key, now() - sinceMs) as { created_at: number }[];
  return rows.map((r) => Number(r.created_at));
}

/** Records one event and opportunistically prunes anything older than a day, across all scopes. */
export function recordRateLimitEvent(scope: string, key: string): void {
  db.prepare('INSERT INTO rate_limit_events (scope, key, created_at) VALUES (?, ?, ?)').run(scope, key, now());
  db.prepare('DELETE FROM rate_limit_events WHERE created_at < ?').run(now() - 24 * 60 * 60 * 1000);
}

/**
 * §ב4: a hard delete, not a flag. Removes the user row (which carries
 * ledger_json — there is no separate ledger table), every auth token,
 * every session and its turns, and any lockout — the exact list the
 * account-deletion promise in §7B of the system prompt covers. Wrapped in
 * a transaction so a mid-delete failure can't leave the account half gone.
 */
export function deleteUser(userId: number): void {
  db.exec('BEGIN');
  try {
    const sessionRows = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as {
      id: number;
    }[];
    for (const s of sessionRows) {
      db.prepare('DELETE FROM turns WHERE session_id = ?').run(Number(s.id));
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM lockouts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
