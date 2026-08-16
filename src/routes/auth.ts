import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import { consumeLoginCode, createToken, storeLoginCode, upsertUser, userIdForToken } from '../db.js';

export const authRouter = Router();

const CODE_TTL_MS = 15 * 60 * 1000;

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
        text: `${code}\n\nThis code expires in 15 minutes.`,
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
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  storeLoginCode(email, code, CODE_TTL_MS);
  await sendCode(email, code);
  res.json({ ok: true, delivery: config.mailer });
});

authRouter.post('/verify', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').trim();
  if (!consumeLoginCode(email, code)) {
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
