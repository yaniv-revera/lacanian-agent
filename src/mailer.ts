import { config } from './config.js';

/**
 * Shared by auth.ts (login codes) and session.ts (gate notifications).
 * MAILER=smtp is optional here; item 4 hardens this to a real dependency
 * and refuses to start in production on MAILER=console.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (config.mailer === 'smtp' && config.smtpUrl) {
    // Optional dependency: `npm i nodemailer` only when SMTP is actually used.
    const spec = 'node' + 'mailer'; // computed so tsc does not resolve an optional dep
    const mod: any = await import(spec).catch(() => null);
    if (!mod) {
      console.error('[mail] MAILER=smtp but nodemailer is not installed; falling back to console.');
    } else {
      const transport = (mod.default ?? mod).createTransport(config.smtpUrl);
      await transport.sendMail({ from: config.mailFrom, to, subject, text });
      return;
    }
  }
  console.error(`\n[mail:console] to=${to} subject=${subject}\n${text}\n`);
}
