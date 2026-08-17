import { Router } from 'express';
import { config } from '../config.js';
import {
  appendTurn,
  getLedger,
  getSession,
  lockoutUntil,
  openSession,
  recentActs,
  saveLedger,
  sessionTranscript,
  sessionTurns,
  setLockout,
  updateSession,
} from '../db.js';
import { requireUser } from './auth.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { parseTurn } from '../agent/parse.js';
import {
  auditTurn,
  consecutiveMinimalActs,
  evaluateEnd,
  isChallengeAct,
  shouldLock,
  withRunLimitRetry,
} from '../agent/guards.js';
import { recordAnalystNote, updateLedgerFromUser } from '../agent/ledger.js';
import { getProvider, type ChatMessage } from '../llm/index.js';

export const sessionRouter = Router();

function auth(req: any, res: any): number | null {
  const uid = requireUser(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return uid;
}

/** State of the door. */
sessionRouter.get('/state', (req, res) => {
  const uid = auth(req, res);
  if (uid === null) return;

  const until = lockoutUntil(uid);
  if (until) {
    res.json({ locked: true, until, now: Date.now() });
    return;
  }

  const s = openSession(uid);
  const turns = sessionTurns(s.id)
    .filter((t) => t.role === 'user' || t.role === 'analyst')
    .map((t) => ({ role: t.role, text: t.text }));

  res.json({
    locked: false,
    sessionId: s.id,
    sessionIndex: s.session_index,
    turnCount: s.turn_count,
    gateLatched: !!s.gate_latched,
    turns,
  });
});

sessionRouter.post('/say', async (req, res) => {
  const uid = auth(req, res);
  if (uid === null) return;

  const until = lockoutUntil(uid);
  if (until) {
    res.status(423).json({ error: 'locked', until });
    return;
  }

  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'empty' });
    return;
  }
  if (text.length > 8000) {
    res.status(400).json({ error: 'too_long' });
    return;
  }

  const s = openSession(uid);
  const nextIdx = s.turn_count + 1;

  // 1. Record what was said and read it into the ledger.
  appendTurn(s.id, nextIdx, 'user', text);
  const before = getLedger(uid);
  const { ledger: afterUser, desupposition } = updateLedgerFromUser(
    before,
    text,
    s.session_index,
    nextIdx,
  );

  // 2. Build the position.
  const acts = recentActs(s.id, 5);
  const endPermitted =
    !s.gate_latched && nextIdx >= config.minTurnsBeforeEnd && acts[0] !== 'A16';

  const system = buildSystemPrompt({
    ledger: { ...afterUser, session_count: s.session_index },
    sessionIndex: s.session_index,
    turnIndex: nextIdx,
    gateLatched: !!s.gate_latched,
    challengeActsLast5: acts.filter(isChallengeAct).length,
    consecutiveMinimalActs: consecutiveMinimalActs(acts),
    endPermitted,
  });

  const history: ChatMessage[] = sessionTurns(s.id).map((t) => ({
    role: t.role === 'user' ? 'user' : 'assistant',
    content: t.text,
  }));

  // 3. Speak.
  let raw: string;
  try {
    raw = await getProvider().complete(system, history);
  } catch (err) {
    console.error('[llm] failure', err);
    res.status(502).json({ error: 'provider_failure' });
    return;
  }

  let parsed = parseTurn(raw);
  if (!parsed.say) parsed.say = 'Go on.';

  // 3b. Run-limit enforcement: a third consecutive identical act gets one
  // regeneration. Safety and required speech are never regenerated for this.
  let runLimitRetryFailedAct: string | null = null;
  try {
    const retryResult = await withRunLimitRetry(parsed, raw, acts, async (forbiddenAct) => {
      const retrySystem = {
        stable: system.stable,
        volatile:
          system.volatile +
          `\n\nSERVER OVERRIDE: ${forbiddenAct} would be the third consecutive identical act this turn. ${forbiddenAct} is forbidden — choose a different act, or A20.`,
      };
      return getProvider().complete(retrySystem, history);
    });
    if (retryResult.retried) {
      parsed = retryResult.parsed;
      if (!parsed.say) parsed.say = 'Go on.';
      if (retryResult.retryFailed) runLimitRetryFailedAct = retryResult.forbiddenAct;
    }
  } catch (err) {
    console.error('[llm] run-limit retry failed, using original draft', err);
  }

  // 4. Enforce the frame. The model proposes; the server disposes.
  const gateLatched = !!s.gate_latched || parsed.gateFired;
  const decision = evaluateEnd(parsed.wantsEnd, {
    turnCount: nextIdx,
    gateLatched,
    lastAnalystAct: acts[0] ?? null,
    mode: parsed.mode,
  });

  const flags = auditTurn(parsed, { recentActs: acts, mode: parsed.mode, turnCount: nextIdx });
  if (parsed.wantsEnd && !decision.allowed) flags.push(`end_refused:${decision.reason}`);
  if (desupposition) flags.push('desupposition_by_user');
  if (runLimitRetryFailedAct) flags.push(`run_limit_retry_failed:${runLimitRetryFailedAct}`);
  if (flags.length) console.error(`[audit s${s.id} t${nextIdx}]`, flags.join(' '));

  const workLog = [parsed.work, flags.length ? `\n[server flags] ${flags.join(' ')}` : ''].join('');
  appendTurn(s.id, nextIdx, 'analyst', parsed.say, workLog, parsed.act ?? undefined);

  saveLedger(uid, recordAnalystNote({ ...afterUser, session_count: s.session_index }, parsed.ledgerNote));
  updateSession(s.id, {
    turn_count: nextIdx,
    gate_latched: gateLatched ? 1 : 0,
    mode: parsed.mode,
  });

  // 5. The end, and the door.
  if (decision.allowed) {
    const endedBy = decision.forced ? 'ceiling' : 'analyst';
    updateSession(s.id, { ended_at: Date.now(), ended_by: endedBy });

    const lock = shouldLock({
      gateEverLatched: gateLatched,
      endedInAnchored: parsed.mode === 'ANCHORED',
    });

    let lockedUntil: number | null = null;
    if (lock.lock) {
      lockedUntil = Date.now() + config.lockoutHours * 60 * 60 * 1000;
      setLockout(uid, lockedUntil, s.id);
    }
    console.error(
      `[frame] session ${s.id} ended by ${endedBy}; lock=${lock.lock} (${lock.reason})`,
    );

    res.json({
      say: parsed.say,
      ended: true,
      endedBy,
      locked: lock.lock,
      until: lockedUntil,
      lockReason: lock.reason,
    });
    return;
  }

  res.json({ say: parsed.say, ended: false, turnCount: nextIdx, gateLatched });
});

/** Transcript export — the human review the spec requires is not optional. */
sessionRouter.get('/transcript/:id', (req, res) => {
  const uid = auth(req, res);
  if (uid === null) return;
  const s = getSession(Number(req.params.id));
  if (!s || s.user_id !== uid) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ session: s, turns: sessionTranscript(s.id) });
});
