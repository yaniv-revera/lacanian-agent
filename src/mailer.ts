import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!transport) transport = nodemailer.createTransport(config.smtpUrl);
  return transport;
}

/**
 * Pilot item 4: real SMTP, not a best-effort optional import. In
 * production, MAILER=console is refused at startup (assertProductionSafety),
 * so the console branch below only ever runs locally. A send failure here
 * throws — callers (auth.ts, session.ts) decide how loudly to handle it.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (config.mailer === 'smtp') {
    if (!config.smtpUrl) throw new Error('MAILER=smtp but SMTP_URL is empty.');
    await getTransport().sendMail({ from: config.mailFrom, to, subject, text });
    return;
  }
  console.error(`\n[mail:console] to=${to} subject=${subject}\n${text}\n`);
}
