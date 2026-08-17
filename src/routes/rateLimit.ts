import { now, rateLimitTimestamps, recordRateLimitEvent } from '../db.js';
import { checkRateLimit } from '../agent/security.js';

export type RateLimitGate = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Checks two fixed-window limits under one `scope` — one keyed by
 * `subjectKey` (a user id or an email), one by `ipKey` — and records an
 * event for both only if both are still under their max. Shared by
 * src/routes/auth.ts (§ב1) and src/routes/session.ts (§ב3) so the two
 * places that need per-subject-plus-per-IP limiting don't each reimplement
 * the "check both, record only on success" logic.
 */
export function checkAndRecordRateLimit(
  scope: string,
  subjectKey: string,
  ipKey: string,
  windowMinutes: number,
  maxPerSubject: number,
  maxPerIp: number,
): RateLimitGate {
  const windowMs = windowMinutes * 60 * 1000;
  const t = now();
  const subjectDecision = checkRateLimit(
    rateLimitTimestamps(scope, subjectKey, windowMs),
    t,
    windowMs,
    maxPerSubject,
  );
  const ipDecision = checkRateLimit(rateLimitTimestamps(scope, ipKey, windowMs), t, windowMs, maxPerIp);
  if (!subjectDecision.allowed || !ipDecision.allowed) {
    return { allowed: false, retryAfterMs: Math.max(subjectDecision.retryAfterMs, ipDecision.retryAfterMs) };
  }
  recordRateLimitEvent(scope, subjectKey);
  recordRateLimitEvent(scope, ipKey);
  return { allowed: true };
}

/**
 * A plain, non-analytic error body. session.ts must return exactly this
 * shape on a rate-limit refusal — never a `{ say: ... }` turn — so a
 * refusal is never mistaken for, or routed through, the analyst's voice.
 */
export function rateLimitedResponse(retryAfterMs: number): { error: 'rate_limited'; retryAfterSeconds: number } {
  return { error: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}
