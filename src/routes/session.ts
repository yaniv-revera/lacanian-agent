import { Router } from 'express';
import { config } from '../config.js';
import {
  appendTurn,
  countAct,
  getConsentStatus,
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
import { checkAndRecordRateLimit, rateLimitedResponse } from './rateLimit.js';
import { CONSENT_VERSION, CONSENT_TEXT_V1, needsConsent } from '../agent/consent.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { parseTurn } from '../agent/parse.js';
import {
  auditTurn,
  consecutiveMinimalActs,
  emptySayFallback,
  evaluateEnd,
  isChallengeAct,
  matchMinimalForm,
  retryFailureFlag,
  retryOverrideMessage,
  shouldLock,
  withDraftRetry,
} from '../agent/guards.js';
import {
  assentRunStats,
  blockedSignifiers,
  isA14Excluded,
  isA15Excluded,
  isExplicitCrisisLanguage,
  isFrameComplaint,
  isSessionOpeningTrigger,
  recordAnalystNote,
  recordEchoedSignifier,
  recordNominations,
  reportsRepetition,
  updateLedgerFromUser,
} from '../agent/ledger.js';
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

/**
 * Pilot item 1: no session may begin — or continue — without active
 * consent to the current CONSENT_VERSION. The text is included in the
 * response so the frontend can render the consent screen without a
 * second round trip.
 */
function requireConsent(uid: number, res: any): boolean {
  if (!needsConsent(getConsentStatus(uid), CONSENT_VERSION)) return true;
  res.status(403).json({ error: 'consent_required', version: CONSENT_VERSION, text: CONSENT_TEXT_V1 });
  return false;
}

/** State of the door. */
sessionRouter.get('/state', (req, res) => {
  const uid = auth(req, res);
  if (uid === null) return;
  if (!requireConsent(uid, res)) return;

  const gate = checkAndRecordRateLimit(
    'session_create',
    `user:${uid}`,
    `ip:${req.ip ?? 'unknown'}`,
    config.sessionCreateWindowMinutes,
    config.sessionCreateMaxPerUser,
    config.sessionCreateMaxPerIp,
  );
  if (!gate.allowed) {
    res.status(429).json(rateLimitedResponse(gate.retryAfterMs));
    return;
  }

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
  if (!requireConsent(uid, res)) return;

  const gate = checkAndRecordRateLimit(
    'turn_submit',
    `user:${uid}`,
    `ip:${req.ip ?? 'unknown'}`,
    config.turnSubmitWindowMinutes,
    config.turnSubmitMaxPerUser,
    config.turnSubmitMaxPerIp,
  );
  if (!gate.allowed) {
    // Plain and non-analytic on purpose (§ב3) — this must never look like
    // a turn from the analyst, so it is never shaped as { say: ... }.
    res.status(429).json(rateLimitedResponse(gate.retryAfterMs));
    return;
  }

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

  // 1. Record what was said and read it into the ledger. The UI's opening
  // nudge ("(begins)", turn 1) is a stage direction, not analysand speech —
  // it is still recorded as a turn (the model needs something to respond
  // to), but it must never feed the ledger or any analysand-turn analysis.
  appendTurn(s.id, nextIdx, 'user', text);
  const before = getLedger(uid);
  const openingTrigger = isSessionOpeningTrigger(nextIdx, text);
  const { ledger: afterUser, desupposition } = openingTrigger
    ? { ledger: before, desupposition: false }
    : updateLedgerFromUser(before, text, s.session_index, nextIdx);

  // 2. Build the position.
  const acts = recentActs(s.id, 5);
  const allTurns = sessionTurns(s.id);
  const endPermitted =
    !s.gate_latched && nextIdx >= config.minTurnsBeforeEnd && acts[0] !== 'A16';

  const userTurns = allTurns.filter(
    (t) => t.role === 'user' && !isSessionOpeningTrigger(t.idx, t.text),
  );
  const assentCountLast5 = assentRunStats(userTurns.map((t) => t.text)).count;

  const recentAnalystUtterances = allTurns
    .filter((t) => t.role === 'analyst')
    .map((t) => t.text)
    .slice(-3);

  const a16CountThisSession = countAct(s.id, 'A16');

  const blocked = blockedSignifiers(
    afterUser.echoed_signifiers,
    nextIdx,
    userTurns.map((t) => ({ idx: t.idx, text: t.text })),
  );

  const usedMinimalForms = [
    ...new Set(
      allTurns
        .filter((t) => t.role === 'analyst' && t.act === 'A1')
        .map((t) => matchMinimalForm(t.text))
        .filter((f): f is string => f !== null),
    ),
  ];
  const userFrameComplaint = isFrameComplaint(text);
  const userReportsRepetition = reportsRepetition(text);
  const userA14Excluded = isA14Excluded(text);
  const userA15Excluded = isA15Excluded(text);
  const userExplicitCrisisLanguage = isExplicitCrisisLanguage(text);

  const system = buildSystemPrompt({
    ledger: { ...afterUser, session_count: s.session_index },
    sessionIndex: s.session_index,
    turnIndex: nextIdx,
    gateLatched: !!s.gate_latched,
    challengeActsLast5: acts.filter(isChallengeAct).length,
    consecutiveMinimalActs: consecutiveMinimalActs(acts),
    a16CountThisSession,
    a16Cap: config.maxA16PerSession,
    blockedSignifiers: blocked,
    usedMinimalForms,
    assentCountLast5,
    endPermitted,
  });

  const history: ChatMessage[] = allTurns.map((t) => ({
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
  if (!parsed.say) parsed.say = emptySayFallback(parsed.mode, config.crisisResources);

  // 3b. Draft-retry enforcement: a hard block on a minimal act when the
  // analysand reports repetition or complains about the frame, a run limit, a
  // reused minimal form, the A16 cap/window, a blocked signifier returned in
  // any form, or a near-duplicate utterance each get exactly one
  // regeneration. Safety and required speech are never regenerated for this.
  let retryFailFlag: string | null = null;
  try {
    const retryResult = await withDraftRetry(
      parsed,
      raw,
      {
        recentActs: acts,
        a16CountThisSession,
        blockedSignifiers: blocked,
        recentAnalystUtterances,
        usedMinimalForms,
        userFrameComplaint,
        userReportsRepetition,
        userA14Excluded,
        userA15Excluded,
        userExplicitCrisisLanguage,
      },
      async (reason) => {
        const retrySystem = {
          stable: system.stable,
          volatile: system.volatile + retryOverrideMessage(reason),
        };
        return getProvider().complete(retrySystem, history);
      },
    );
    if (retryResult.retried) {
      parsed = retryResult.parsed;
      if (!parsed.say) parsed.say = emptySayFallback(parsed.mode, config.crisisResources);
      if (retryResult.retryErrored && retryResult.reason) {
        // The retry call itself failed (network/provider error), not a
        // repeated violation. withDraftRetry has already substituted a safe
        // fallback into retryResult.parsed — this flag is purely for human
        // review, distinguishing "the safety net had to catch a transport
        // failure" from an ordinary retry-still-violates outcome.
        retryFailFlag = `retry_errored_safe_fallback_used:${retryFailureFlag(retryResult.reason)}`;
      } else if (retryResult.substituted) {
        retryFailFlag = `minimal_form_substituted:${retryResult.substituted.from}->${retryResult.substituted.to}`;
      } else if (retryResult.retryFailed && retryResult.reason) {
        retryFailFlag = retryFailureFlag(retryResult.reason);
      }
    }
  } catch (err) {
    // withDraftRetry now handles a failed retry() call internally (finding
    // 3) — this is a last-resort net for a genuinely unexpected error
    // elsewhere in the pipeline, not the retry-call-failure path itself.
    console.error('[llm] unexpected error in draft-retry pipeline, using original draft', err);
  }

  // 4. Enforce the frame. The model proposes; the server disposes.
  const gateLatched = !!s.gate_latched || parsed.gateFired;
  const decision = evaluateEnd(parsed.wantsEnd, {
    turnCount: nextIdx,
    gateLatched,
    lastAnalystAct: acts[0] ?? null,
    mode: parsed.mode,
  });

  const flags = auditTurn(parsed, {
    recentActs: acts,
    mode: parsed.mode,
    turnCount: nextIdx,
    assentCountLast5,
  });
  if (parsed.wantsEnd && !decision.allowed) flags.push(`end_refused:${decision.reason}`);
  if (desupposition) flags.push('desupposition_by_user');
  if (retryFailFlag) flags.push(retryFailFlag);
  if (flags.length) console.error(`[audit s${s.id} t${nextIdx}]`, flags.join(' '));

  const workLog = [parsed.work, flags.length ? `\n[server flags] ${flags.join(' ')}` : ''].join('');
  appendTurn(s.id, nextIdx, 'analyst', parsed.say, workLog, parsed.act ?? undefined);

  const ledgerAfterAnalyst = recordNominations(
    recordEchoedSignifier(
      recordAnalystNote({ ...afterUser, session_count: s.session_index }, parsed.ledgerNote),
      parsed.act,
      parsed.say,
      nextIdx,
    ),
    parsed,
    s.session_index,
    nextIdx,
  );
  saveLedger(uid, ledgerAfterAnalyst);
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
