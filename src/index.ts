import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertProductionSafety, assertProviderConfigured, config } from './config.js';
import { authRouter } from './routes/auth.js';
import { sessionRouter } from './routes/session.js';
import './db.js';

const here = dirname(fileURLToPath(import.meta.url));

assertProviderConfigured();
assertProductionSafety();

const app = express();
// fly.io terminates TLS at its edge and proxies over a single trusted hop, so
// req.ip is otherwise the proxy's address, not the caller's — which would
// collapse the per-IP rate limits (§ב1, §ב3) onto one shared bucket for
// every visitor.
app.set('trust proxy', 1);
// Pilot item 7: a closed research pilot has no reason to be indexed, and
// every reason not to be findable by search or crawled by a bot.
// robots.txt covers well-behaved crawlers; the header covers the rest.
app.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
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
    // The raw text, not just whether it's set: this is public and unauthenticated
    // on purpose — the login and consent screens need it before anyone signs in,
    // and it is exactly the text the analyst itself is allowed to say (never invented).
    crisisResourcesText: config.crisisResources === 'UNAVAILABLE' ? '' : config.crisisResources,
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
