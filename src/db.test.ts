// Integration test against a real (temporary, throwaway) SQLite file — the
// one exception to this repo's "pure functions only" test pattern. A "delete
// my data" promise deserves proof against the actual cascading deletes, not
// just code review; DB_PATH is overridden before db.js is imported so this
// never touches the real database.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), `lacanian-db-test-${Date.now()}-${process.pid}`);
mkdirSync(dir, { recursive: true });
process.env.DB_PATH = join(dir, 'test.db');

const {
  db,
  upsertUser,
  createToken,
  openSession,
  appendTurn,
  setLockout,
  saveLedger,
  deleteUser,
} = await import('./db.js');
const { emptyLedger } = await import('./types.js');

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

t('deleteUser hard-deletes the user, tokens, sessions, turns, ledger, and lockouts', () => {
  const user = upsertUser('delete-me@test.com');
  saveLedger(user.id, { ...emptyLedger(), session_count: 3 });
  createToken(user.id, 'token-under-test', 60_000);
  const session = openSession(user.id);
  appendTurn(session.id, 1, 'user', 'hello');
  appendTurn(session.id, 2, 'analyst', 'you said hello');
  setLockout(user.id, Date.now() + 60_000, session.id);

  // Sanity check: everything actually exists before deletion, or the
  // "gone after" assertions below would be vacuously true.
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(user.id));
  assert.ok(db.prepare('SELECT token FROM auth_tokens WHERE user_id = ?').get(user.id));
  assert.ok(db.prepare('SELECT id FROM sessions WHERE user_id = ?').get(user.id));
  assert.ok(db.prepare('SELECT id FROM turns WHERE session_id = ?').get(session.id));
  assert.ok(db.prepare('SELECT user_id FROM lockouts WHERE user_id = ?').get(user.id));

  deleteUser(user.id);

  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(user.id), undefined);
  assert.equal(db.prepare('SELECT token FROM auth_tokens WHERE user_id = ?').get(user.id), undefined);
  assert.equal(db.prepare('SELECT id FROM sessions WHERE user_id = ?').get(user.id), undefined);
  assert.equal(db.prepare('SELECT id FROM turns WHERE session_id = ?').get(session.id), undefined);
  assert.equal(db.prepare('SELECT user_id FROM lockouts WHERE user_id = ?').get(user.id), undefined);
});

t('deleteUser removes every session and every turn when a user has more than one session', () => {
  const user = upsertUser('multi-session@test.com');
  const s1 = openSession(user.id);
  appendTurn(s1.id, 1, 'user', 'first session');
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), s1.id);
  const s2 = openSession(user.id);
  appendTurn(s2.id, 1, 'user', 'second session');

  deleteUser(user.id);

  assert.equal(db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(user.id).length, 0);
  assert.equal(db.prepare('SELECT id FROM turns WHERE session_id IN (?, ?)').all(s1.id, s2.id).length, 0);
});

t('deleteUser on an id with no rows at all does not throw', () => {
  deleteUser(999_999);
});

console.error(`\n  ${passed} db tests passed\n`);
rmSync(dir, { recursive: true, force: true });
