import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertProviderConfigured, config } from './config.js';
import { authRouter } from './routes/auth.js';
import { sessionRouter } from './routes/session.js';
import './db.js';

const here = dirname(fileURLToPath(import.meta.url));

assertProviderConfigured();

const app = express();
// fly.io terminates TLS at its edge and proxies over a single trusted hop, so
// req.ip is otherwise the proxy's address, not the caller's — which would
// collapse the per-IP rate limits (§ב1, §ב3) onto one shared bucket for
// every visitor.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(resolve(here, '../public')));

app.use('/api/auth', authRouter);
app.use('/api/session', sessionRouter);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: config.provider,
    lockoutHours: config.lockoutHours,
    crisisResources: config.crisisResources === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'configured',
  });
});

app.listen(config.port, () => {
  console.error(`\n  listening on http://localhost:${config.port}`);
  console.error(`  provider: ${config.provider}`);
  console.error(`  lockout: ${config.lockoutHours}h after the analyst ends a session`);
  if (config.crisisResources === 'UNAVAILABLE') {
    console.error(
      `  warning: CRISIS_RESOURCES is empty. The agent will say it has no verified number\n` +
        `           rather than invent one, but you should set it before anyone real uses this.`,
    );
  }
  console.error('');
});
