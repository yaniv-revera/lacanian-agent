import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Both sides are hashed to a fixed 32-byte digest before comparison, so the
 * comparison itself never branches on the length of attacker-supplied input
 * (a raw `timingSafeEqual` throws on unequal-length buffers, and any
 * length check ahead of it — or a `WHERE code = ?` in SQL — reintroduces a
 * timing side channel keyed on how many leading digits match).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest();
  const bh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ah, bh);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 0 when allowed; otherwise how long until the oldest in-window event ages out. */
  retryAfterMs: number;
}

/**
 * Fixed-window counter. `timestamps` are prior event times for one key
 * (email, IP, ...) within one scope; `now` is the time of the attempt being
 * evaluated and is not itself included in `timestamps`.
 */
export function checkRateLimit(
  timestamps: number[],
  now: number,
  windowMs: number,
  max: number,
): RateLimitDecision {
  const windowStart = now - windowMs;
  const inWindow = timestamps.filter((t) => t > windowStart);
  if (inWindow.length < max) {
    return { allowed: true, retryAfterMs: 0 };
  }
  const oldest = Math.min(...inWindow);
  return { allowed: false, retryAfterMs: oldest + windowMs - now };
}

export type LoginCodeVerifyResult = 'ok' | 'bad' | 'locked';

export interface LoginCodeRecord {
  code: string;
  expiresAt: number;
  used: boolean;
  attempts: number;
}

export interface LoginCodeVerdict {
  result: LoginCodeVerifyResult;
  /** Whether the caller should persist an incremented attempt count for this row. */
  incrementAttempt: boolean;
}

/**
 * Pure decision core for §ב1. `bad` covers "no such code", "wrong code",
 * "already used", and "expired" identically and on purpose: none of those
 * reasons may be distinguishable from one another in the response, or an
 * attacker can use the distinction as an oracle for whether an email has
 * ever requested a code at all.
 *
 * A row already at `maxAttempts` returns `locked` even when the supplied
 * code is correct — once the attempt budget for a code is spent, that code
 * is burned, not just the wrong guesses against it.
 */
export function evaluateLoginCode(
  record: LoginCodeRecord | undefined,
  suppliedCode: string,
  now: number,
  maxAttempts: number,
): LoginCodeVerdict {
  if (!record || record.used || record.expiresAt <= now) {
    return { result: 'bad', incrementAttempt: false };
  }
  if (record.attempts >= maxAttempts) {
    return { result: 'locked', incrementAttempt: false };
  }
  if (!constantTimeEqual(record.code, suppliedCode)) {
    return { result: 'bad', incrementAttempt: true };
  }
  return { result: 'ok', incrementAttempt: false };
}

export interface AuthTokenRecord {
  userId: number;
  expiresAt: number;
}

export type AuthTokenVerdict = { valid: true; userId: number } | { valid: false };

/** §ב2: a token at or past its expiry instant is invalid — `<=`, not `<`. */
export function evaluateAuthToken(record: AuthTokenRecord | undefined, now: number): AuthTokenVerdict {
  if (!record || record.expiresAt <= now) return { valid: false };
  return { valid: true, userId: record.userId };
}
