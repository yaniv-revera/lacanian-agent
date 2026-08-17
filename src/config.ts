import 'dotenv/config';

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 3000),
  dbPath: process.env.DB_PATH ?? './data/app.db',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',

  provider: (process.env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai' | 'mock',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',

  // The frame. These are enforced server-side, not left to the model.
  lockoutHours: num('LOCKOUT_HOURS', 24),
  minTurnsBeforeEnd: num('MIN_TURNS_BEFORE_END', 15),
  maxTurns: num('MAX_TURNS', 40),
  maxA16PerSession: num('MAX_A16_PER_SESSION', 3),

  crisisResources: process.env.CRISIS_RESOURCES?.trim() || 'UNAVAILABLE',

  // Gate-touched sessions are never locked — that is not configurable.
  // Anchored sessions are also spared by default; set to false to lock them too.
  skipLockoutAfterAnchored: (process.env.LOCKOUT_SKIP_ANCHORED ?? 'true') !== 'false',

  mailer: (process.env.MAILER ?? 'console') as 'console' | 'smtp',
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'no-reply@localhost',
};

export function assertProviderConfigured(): void {
  if (config.provider === 'mock') return;
  if (config.provider === 'anthropic' && !config.anthropicKey) {
    throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty. See .env.example');
  }
  if (config.provider === 'openai' && !config.openaiKey) {
    throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is empty. See .env.example');
  }
}
