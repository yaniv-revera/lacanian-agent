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
  isProduction: (process.env.NODE_ENV ?? '') === 'production',

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

  // §ב1: login-code brute-force protection.
  loginCodeTtlMinutes: num('LOGIN_CODE_TTL_MINUTES', 10),
  loginCodeMaxAttempts: num('LOGIN_CODE_MAX_ATTEMPTS', 5),
  // Requesting codes: per-email is tight (one legitimate person rarely needs
  // more than a couple in a row); per-IP is looser, to allow a shared office
  // or NAT to have several people signing in without tripping each other.
  loginRequestWindowMinutes: num('LOGIN_REQUEST_WINDOW_MINUTES', 15),
  loginRequestMaxPerEmail: num('LOGIN_REQUEST_MAX_PER_EMAIL', 3),
  loginRequestMaxPerIp: num('LOGIN_REQUEST_MAX_PER_IP', 10),
  // Verifying codes: the per-code attempt ceiling above is the primary
  // defense; this is a secondary net against spraying attempts across many
  // freshly-requested codes for the same email or from the same IP.
  loginVerifyWindowMinutes: num('LOGIN_VERIFY_WINDOW_MINUTES', 15),
  loginVerifyMaxPerEmail: num('LOGIN_VERIFY_MAX_PER_EMAIL', 10),
  loginVerifyMaxPerIp: num('LOGIN_VERIFY_MAX_PER_IP', 30),

  // §ב2: auth tokens now expire instead of living forever.
  authTokenTtlDays: num('AUTH_TOKEN_TTL_DAYS', 30),

  // §ב3: rate limiting on session creation and turn submission, protecting
  // both the LLM API bill (mainly turnSubmit — each /say call is 1-2
  // provider calls) and the service generally.
  sessionCreateWindowMinutes: num('SESSION_CREATE_WINDOW_MINUTES', 5),
  sessionCreateMaxPerUser: num('SESSION_CREATE_MAX_PER_USER', 30),
  sessionCreateMaxPerIp: num('SESSION_CREATE_MAX_PER_IP', 90),
  turnSubmitWindowMinutes: num('TURN_SUBMIT_WINDOW_MINUTES', 5),
  turnSubmitMaxPerUser: num('TURN_SUBMIT_MAX_PER_USER', 30),
  turnSubmitMaxPerIp: num('TURN_SUBMIT_MAX_PER_IP', 60),

  // Pilot item 2: a closed list of known participants. Empty means
  // unrestricted — fine for local dev, refused outright in production by
  // assertProductionSafety() below.
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
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

/**
 * Fail-closed checks that only apply once NODE_ENV=production — a local
 * dev/mock run is allowed to be permissive, but this pilot is not open to
 * the public, and the server must refuse to even start if a production
 * deploy would otherwise be.
 */
export function assertProductionSafety(): void {
  if (!config.isProduction) return;
  if (config.allowedEmails.length === 0) {
    throw new Error(
      'NODE_ENV=production but ALLOWED_EMAILS is empty. Refusing to start open to the public — set ALLOWED_EMAILS.',
    );
  }
}
