// Integration test, deliberately against a real SQLite file, in its own
// process/file (db.ts's module-load side effects — open, create, migrate —
// run exactly once per process, so a migration test needs a fresh process
// pointed at a database seeded with the ORIGINAL pre-migration schema
// before db.js is ever imported).
//
// The bug this guards against, found in live testing: db.ts's schema block
// is CREATE TABLE IF NOT EXISTS, which is a no-op for a table that already
// exists — a column added to that literal SQL text is silently never
// created on a database file from before the column existed. On fly.io the
// data volume persists across deploys, so the very next schema change would
// have locked out every existing user, including in production, and until
// the column existed the brute-force protection it backs (login_codes
// .attempts) was silently inert.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), `lacanian-migrations-test-${Date.now()}-${process.pid}`);
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, 'old.db');

// The exact schema as it stood before any of the columns below existed —
// commit 4e3127c, the last commit before login_codes.attempts,
// auth_tokens.expires_at/last_used_at, and users.consented_at/
// consent_version/consent_hash were added.
const ORIGINAL_SCHEMA = `
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
`;

// Seed a database on disk with the original schema AND a real pre-existing
// row in each affected table, so the migration has to run against actual
// data, not just empty tables — and close the connection before db.ts (a
// second connection to the same file) ever opens it.
{
  const seed = new DatabaseSync(dbPath);
  seed.exec(ORIGINAL_SCHEMA);
  seed.prepare('INSERT INTO users (id, email, created_at, ledger_json) VALUES (1, ?, ?, ?)').run(
    'pre-migration@test.com',
    Date.now(),
    '{}',
  );
  seed.prepare('INSERT INTO login_codes (email, code, expires_at, used) VALUES (?, ?, ?, 0)').run(
    'pre-migration@test.com',
    '000000',
    Date.now() + 60_000,
  );
  seed.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, 1, ?)').run(
    'pre-existing-token',
    Date.now(),
  );
  seed.close();
}

process.env.DB_PATH = dbPath;

// Importing db.js now runs its module-load side effects — including
// runMigrations() — against the file seeded above, exactly as it would at
// real server startup.
const {
  db,
  consumeLoginCode,
  createToken,
  userIdForToken,
  recordConsent,
  getConsentStatus,
  upsertUser,
  runMigrations,
} = await import('./db.js');

let passed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

t('migrations backfill login_codes.attempts on a pre-existing database', () => {
  const row = db.prepare('SELECT attempts FROM login_codes WHERE email = ?').get('pre-migration@test.com') as
    | { attempts: number }
    | undefined;
  assert.equal(row?.attempts, 0);
});

t('migrations backfill auth_tokens.expires_at and last_used_at on a pre-existing database', () => {
  const row = db.prepare('SELECT expires_at, last_used_at FROM auth_tokens WHERE token = ?').get(
    'pre-existing-token',
  ) as { expires_at: number; last_used_at: number } | undefined;
  assert.equal(row?.expires_at, 0);
  assert.equal(row?.last_used_at, 0);
});

t('migrations backfill consent columns on users', () => {
  const row = db.prepare('SELECT consented_at, consent_version, consent_hash FROM users WHERE id = 1').get() as
    | { consented_at: number | null; consent_version: string | null; consent_hash: string | null }
    | undefined;
  assert.equal(row?.consented_at ?? null, null);
  assert.equal(row?.consent_version ?? null, null);
});

t('consumeLoginCode works against the migrated database (the exact bug reported live)', () => {
  const result = consumeLoginCode('pre-migration@test.com', '000000', 5);
  assert.equal(result, 'ok');
});

t('createToken and userIdForToken work against the migrated database', () => {
  const user = upsertUser('post-migration@test.com');
  createToken(user.id, 'fresh-token', 60_000);
  assert.equal(userIdForToken('fresh-token'), user.id);
});

t('recordConsent and getConsentStatus work against the migrated database', () => {
  recordConsent(1, 'v1', 'deadbeef');
  const status = getConsentStatus(1);
  assert.equal(status.consentVersion, 'v1');
  assert.equal(status.consentedAt !== null, true);
});

t('running migrations again against an already-migrated database is a no-op, not an error', () => {
  const before = db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all();
  runMigrations();
  const after = db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all();
  assert.deepEqual(after, before);
});

console.error(`\n  ${passed} migration tests passed\n`);
rmSync(dir, { recursive: true, force: true });
