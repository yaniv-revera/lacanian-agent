import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import {
  consumeLoginCode,
  createToken,
  now,
  rateLimitTimestamps,
  recordRateLimitEvent,
  storeLoginCode,
  upsertUser,
  userIdForToken,
} from '../db.js';
import { checkRateLimit } from '../agent/security.js';

export const authRouter = Router();

const CODE_TTL_MS = config.loginCodeTtlMinutes * 60 * 1000;

/**
 * Same 429 body regardless of scope or key, so a rate-limited response never
 * tells the caller *which* limit (email or IP) tripped — only that one did.
 */
function rateLimited(retryAfterMs: number): { error: 'rate_limited'; retryAfterSeconds: number } {
  return { error: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/** Checks and, if allowed, records an event for both the email and IP keys under `scope`. */
function checkAndRecord(
  scope: string,
  email: string,
  ip: string,
  windowMinutes: number,
  maxPerEmail: number,
  maxPerIp: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const windowMs = windowMinutes * 60 * 1000;
  const t = now();
  const emailDecision = checkRateLimit(rateLimitTimestamps(scope, `email:${email}`, windowMs), t, windowMs, maxPerEmail);
  const ipDecision = checkRateLimit(rateLimitTimestamps(scope, `ip:${ip}`, windowMs), t, windowMs, maxPerIp);
  if (!emailDecision.allowed || !ipDecision.allowed) {
    return { allowed: false, retryAfterMs: Math.max(emailDecision.retryAfterMs, ipDecision.retryAfterMs) };
  }
  recordRateLimitEvent(scope, `email:${email}`);
  recordRateLimitEvent(scope, `ip:${ip}`);
  return { allowed: true };
}

async function sendCode(email: string, code: string): Promise<void> {
  if (config.mailer === 'smtp' && config.smtpUrl) {
    // Optional dependency: `npm i nodemailer` only when SMTP is actually used.
    const spec = 'node' + 'mailer'; // computed so tsc does not resolve an optional dep
    const mod: any = await import(spec).catch(() => null);
    if (!mod) {
      console.error('[mail] MAILER=smtp but nodemailer is not installed; falling back to console.');
    } else {
      const transport = (mod.default ?? mod).createTransport(config.smtpUrl);
      await transport.sendMail({
        from: config.mailFrom,
        to: email,
        subject: 'Your code',
        text: `${code}\n\nThis code expires in ${config.loginCodeTtlMinutes} minutes.`,
      });
      return;
    }
  }
  console.error(`\n[login code] ${email} -> ${code}\n`);
}

authRouter.post('/request', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }
  const gate = checkAndRecord(
    'login_request',
    email,
    req.ip ?? 'unknown',
    config.loginRequestWindowMinutes,
    config.loginRequestMaxPerEmail,
    config.loginRequestMaxPerIp,
  );
  if (!gate.allowed) {
    res.status(429).json(rateLimited(gate.retryAfterMs));
    return;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  storeLoginCode(email, code, CODE_TTL_MS);
  await sendCode(email, code);
  res.json({ ok: true, delivery: config.mailer });
});

authRouter.post('/verify', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
  const gate = checkAndRecord(
    'login_verify',
    email,
    req.ip ?? 'unknown',
    config.loginVerifyWindowMinutes,
    config.loginVerifyMaxPerEmail,
    config.loginVerifyMaxPerIp,
  );
  if (!gate.allowed) {
    res.status(429).json(rateLimited(gate.retryAfterMs));
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
  createToken(user.id, token);
  res.json({ token });
});

export function requireUser(req: { headers: Record<string, unknown> }): number | null {
  const header = String(req.headers['authorization'] ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  return userIdForToken(token);
}
