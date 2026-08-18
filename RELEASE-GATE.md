# Release gate

Tracks hard blockers before this service is exposed to anyone. Was discussed
across several conversations but never written down — the same gap that
previously left adversarial rounds 1 and 2 unrecorded. This is group B; group
A (if it exists) has not been named or written down anywhere I can find.

## Group B — security hardening, exposure blockers

All five implemented and tested, TDD, each committed and pushed separately
so they can be reviewed and reverted independently.

- [x] **ב1 — Login-code brute force.** Max 5 attempts per code, single-use,
      10-minute expiry, per-email/IP rate limiting on request and verify,
      reissue invalidates outstanding codes, constant-time comparison, no
      email-existence oracle. `4302ab1`
- [x] **ב2 — Token expiry.** Default 30 days, configurable, `issued_at`/
      `last_used_at` stored, expired tokens rejected, real server-side
      logout. `5a04604`
- [x] **ב3 — Rate limiting** on session creation and turn submission, per
      user and per IP, plain non-analytic error response. `d498340`
- [x] **ב4 — Account deletion.** Real hard delete (user, tokens, sessions,
      turns, ledger, lockouts), §7B's wording brought in line with what the
      endpoint actually does. `c4e338a`
- [x] **ב5 — Secrets.** `.env` never used in production, documented;
      `SESSION_SECRET` removed (was dead code, no genuine use existed).
      `dd833c7`

## Group B, addendum — found in live testing after deploy prep began

- [x] **Schema migrations.** `CREATE TABLE IF NOT EXISTS` is a no-op for a
      table that already exists — any column added to that schema block
      (ב1's `login_codes.attempts`, ב2's `auth_tokens.expires_at`/
      `last_used_at`, informed-consent's `users.consented_at`/
      `consent_version`/`consent_hash`) was never created on a database
      file from before the column existed. On fly.io the data volume
      persists across deploys, so the next schema change would have locked
      out every existing user, including in production, and until the
      column existed the brute-force protection it backs was silently
      inert. Fixed: a `schema_version` table plus ordered, idempotent
      migration steps, run unconditionally at module load — before the
      server accepts any request — and a failure throws, refusing to start
      rather than serving a half-migrated database. Backfills every column
      added since the original schema (audited against `git diff` from the
      last pre-ב1 commit, not from memory): the three above, nothing else —
      `sessions`/`turns`/`lockouts` are unchanged since the original schema.
      New `src/migrations.test.ts`: seeds a real database with the exact
      original schema, imports `db.js` (triggering real startup), and
      asserts the current queries that touch the migrated columns all work.

## Related, not formally part of group B

Built afterward, in response to a scope change (closed research pilot, not
public launch): informed consent, participant allowlist, gate-latch
notification, real SMTP, exclusion notice, one-click withdrawal, robots.txt
— and separately, the Seminar III conduct rules (never complete an
interrupted sentence, A16/A15 additional prohibitions, A1 excluded from
ANCHORED). Not renamed into group B retroactively since the pilot scope and
the original exposure-hardening scope were two different requests; listed
here only so this document doesn't read as though they don't exist.
