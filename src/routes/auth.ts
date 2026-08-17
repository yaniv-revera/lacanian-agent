import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import {
  consumeLoginCode,
  createToken,
  deleteToken,
  deleteUser,
  recordConsent,
  storeLoginCode,
  upsertUser,
  userIdForToken,
} from '../db.js';
import { checkAndRecordRateLimit, rateLimitedResponse } from './rateLimit.js';
import { CONSENT_VERSION, CONSENT_TEXT_V1, hashConsentText } from '../agent/consent.js';
import { isEmailAllowed } from '../agent/allowlist.js';
import { sendMail } from '../mailer.js';

/** Empty list means unrestricted (local dev); a non-empty list is enforced. */
function isAllowed(email: string): boolean {
  return config.allowedEmails.length === 0 || isEmailAllowed(email, config.allowedEmails);
}

export const authRouter = Router();

const CODE_TTL_MS = config.loginCodeTtlMinutes * 60 * 1000;

async function sendCode(email: string, code: string): Promise<void> {
  await sendMail(email, 'Your code', `${code}\n\nThis code expires in ${config.loginCodeTtlMinutes} minutes.`);
}

authRouter.post('/request', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }
  if (!isAllowed(email)) {
    // Neutral: identical to a real success, before any DB write, so this
    // response never reveals whether an email is on the pilot allowlist.
    res.json({ ok: true, delivery: config.mailer });
    return;
  }
  const gate = checkAndRecordRateLimit(
    'login_request',
    `email:${email}`,
    `ip:${req.ip ?? 'unknown'}`,
    config.loginRequestWindowMinutes,
    config.loginRequestMaxPerEmail,
    config.loginRequestMaxPerIp,
  );
  if (!gate.allowed) {
    res.status(429).json(rateLimitedResponse(gate.retryAfterMs));
    return;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  storeLoginCode(email, code, CODE_TTL_MS);
  try {
    await sendCode(email, code);
  } catch (err) {
    console.error(`[mail] FAILED to send login code to ${email}`, err);
    res.status(502).json({ error: 'mail_failure' });
    return;
  }
  res.json({ ok: true, delivery: config.mailer });
});

authRouter.post('/verify', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
  if (!isAllowed(email)) {
    // Same shape as any other rejected code — no distinct oracle for allowlist status.
    res.status(401).json({ error: 'bad_code' });
    return;
  }
  const gate = checkAndRecordRateLimit(
    'login_verify',
    `email:${email}`,
    `ip:${req.ip ?? 'unknown'}`,
    config.loginVerifyWindowMinutes,
    config.loginVerifyMaxPerEmail,
    config.loginVerifyMaxPerIp,
  );
  if (!gate.allowed) {
    res.status(429).json(rateLimitedResponse(gate.retryAfterMs));
    return;
  }
  const result = consumeLoginCode(email, code, config.loginCodeMaxAttempts);
  if (result === 'locked') {
    res.status(429).json({ error: 'too_many_attempts' });
    return;
  }
  if (result === 'bad') {
    res.status(401).json({ error: 'bad_code' });
    return;
  }
  const user = upsertUser(email);
  const token = randomBytes(32).toString('hex');
  createToken(user.id, token, config.authTokenTtlDays * 24 * 60 * 60 * 1000);
  res.json({ token });
});

function tokenFromHeader(req: { headers: Record<string, unknown> }): string | null {
  const header = String(req.headers['authorization'] ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token || null;
}

authRouter.post('/logout', (req, res) => {
  const token = tokenFromHeader(req);
  if (token) deleteToken(token);
  res.json({ ok: true });
});

export function requireUser(req: { headers: Record<string, unknown> }): number | null {
  const token = tokenFromHeader(req);
  if (!token) return null;
  return userIdForToken(token);
}

/**
 * §ב4: a hard delete, in the same request that authenticates it — no
 * confirmation step or grace period, because §7B tells the analysand this
 * is immediate and irreversible. The token that authorized the call is
 * deleted along with everything else (it belongs to auth_tokens, which
 * deleteUser already clears), so there is nothing left to separately log out.
 */
/**
 * Pilot item 1: a session cannot begin without an active checkbox consent
 * to the current CONSENT_VERSION — enforced in session.ts, not here. This
 * endpoint only records that consent. `agree` must be the literal boolean
 * `true`; anything else (missing, a string, false) is rejected, so a
 * pre-checked or auto-submitted box can't stand in for an active choice.
 */
authRouter.post('/consent', (req, res) => {
  const uid = requireUser(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.body?.agree !== true) {
    res.status(400).json({ error: 'consent_not_given' });
    return;
  }
  recordConsent(uid, CONSENT_VERSION, hashConsentText(CONSENT_TEXT_V1));
  res.json({ ok: true, version: CONSENT_VERSION });
});

authRouter.delete('/account', (req, res) => {
  const uid = requireUser(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  deleteUser(uid);
  res.json({ ok: true });
});
