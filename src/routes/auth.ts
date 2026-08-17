import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import {
  consumeLoginCode,
  createToken,
  deleteToken,
  deleteUser,
  storeLoginCode,
  upsertUser,
  userIdForToken,
} from '../db.js';
import { checkAndRecordRateLimit, rateLimitedResponse } from './rateLimit.js';

export const authRouter = Router();

const CODE_TTL_MS = config.loginCodeTtlMinutes * 60 * 1000;

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
  await sendCode(email, code);
  res.json({ ok: true, delivery: config.mailer });
});

authRouter.post('/verify', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
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
authRouter.delete('/account', (req, res) => {
  const uid = requireUser(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  deleteUser(uid);
  res.json({ ok: true });
});
