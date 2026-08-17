import assert from 'node:assert/strict';
import { config } from './config.js';
import {
  evaluateEnd,
  shouldLock,
  auditTurn,
  consecutiveMinimalActs,
  decideDraftRetry,
  withDraftRetry,
  retryOverrideMessage,
  retryFailureFlag,
  matchMinimalForm,
  nextUnusedMinimalForm,
  MINIMAL_FORMS,
  emptySayFallback,
  type DraftRetryContext,
} from './agent/guards.js';
import { parseTurn } from './agent/parse.js';
import {
  normalizeEchoedSignifier,
  recordEchoedSignifier,
  blockedSignifiers,
  isAssentReply,
  assentRunStats,
  isFrameComplaint,
  reportsRepetition,
  updateLedgerFromUser,
  normalizeHebrewPrefix,
  recordSemanticFieldNomination,
  recordBorrowedTermNomination,
  recordFormationNomination,
  recordNominations,
  isSessionOpeningTrigger,
  isA14Excluded,
  isA15Excluded,
} from './agent/ledger.js';
import { emptyLedger } from './types.js';
import type { ParsedTurn } from './types.js';

let passed = 0;
const pending: Promise<void>[] = [];

function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

function at(name: string, fn: () => Promise<void>): void {
  pending.push(
    fn().then(
      () => {
        passed++;
      },
      (e) => {
        console.error(`FAIL ${name}`);
        throw e;
      },
    ),
  );
}

const base = { turnCount: 20, gateLatched: false, lastAnalystAct: 'A3', mode: 'ANALYTIC' as const };

// --- the door ---

t('a latched gate cannot end the session', () => {
  const d = evaluateEnd(true, { ...base, gateLatched: true });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'gate_latched');
});

t('a latched gate is not force-ended by the turn ceiling either', () => {
  const d = evaluateEnd(false, { ...base, gateLatched: true, turnCount: config.maxTurns + 10 });
  assert.equal(d.allowed, false);
});

t('ending is refused below the turn floor', () => {
  const d = evaluateEnd(true, { ...base, turnCount: config.minTurnsBeforeEnd - 1 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'below_turn_floor');
});

t('ending is refused immediately after A16', () => {
  const d = evaluateEnd(true, { ...base, lastAnalystAct: 'A16' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'immediately_after_A16');
});

t('ending is refused in anchored mode', () => {
  const d = evaluateEnd(true, { ...base, mode: 'ANCHORED' });
  assert.equal(d.allowed, false);
});

t('a permitted end is allowed and not forced', () => {
  const d = evaluateEnd(true, base);
  assert.equal(d.allowed, true);
  assert.equal(d.forced, false);
});

t('the ceiling forces an end without the model asking', () => {
  const d = evaluateEnd(false, { ...base, turnCount: config.maxTurns });
  assert.equal(d.allowed, true);
  assert.equal(d.forced, true);
});

// --- the lock ---

t('a gate-touched session is never locked', () => {
  const l = shouldLock({ gateEverLatched: true, endedInAnchored: false });
  assert.equal(l.lock, false);
});

t('a normal end locks', () => {
  const l = shouldLock({ gateEverLatched: false, endedInAnchored: false });
  assert.equal(l.lock, true);
});

// --- parsing ---

t('end tag is detected only when present', () => {
  const withEnd = parseTurn('<work>act: A3</work>\n<say>Enough.</say>\n<end/>');
  assert.equal(withEnd.wantsEnd, true);
  assert.equal(withEnd.say, 'Enough.');
  assert.equal(withEnd.act, 'A3');

  const without = parseTurn('<work>act: A1</work>\n<say>Go on.</say>');
  assert.equal(without.wantsEnd, false);
});

t('a gate turn is recognised and outranks the act field', () => {
  const p = parseTurn('<work>gate: suicidal ideation\nact: GATE</work>\n<say>Let me stop.</say>');
  assert.equal(p.gateFired, true);
  assert.equal(p.mode, 'GATE');
  assert.equal(p.act, 'GATE');
});

t('a missing say block still yields something to show', () => {
  const p = parseTurn('<work>act: A1</work>\nGo on.');
  assert.equal(p.say, 'Go on.');
});

t('act numbers up to A20 parse', () => {
  assert.equal(parseTurn('<work>act: A20 — stating the lack</work><say>I do not.</say>').act, 'A20');
  assert.equal(parseTurn('<work>act: A9</work><say>x</say>').act, 'A9');
});

t('gate field starting with none plus reasoning does not fire the gate', () => {
  const p = parseTurn(
    '<work>gate: none — "afraid of death" alone is not suicidal ideation\nact: A1 — punctuating</work>\n<say>Afraid.</say>'
  );
  assert.equal(p.gateFired, false);
  assert.equal(p.mode, 'ANALYTIC');
  assert.equal(p.act, 'A1');
});

t('gate field starting with no or clear does not fire the gate', () => {
  const noField = parseTurn('<work>gate: no immediate risk here\nact: A3</work>\n<say>x</say>');
  assert.equal(noField.gateFired, false);

  const clearField = parseTurn('<work>gate: clear, nothing gate-worthy\nact: A3</work>\n<say>x</say>');
  assert.equal(clearField.gateFired, false);
});

t('act field merely mentioning GATE elsewhere does not fire the gate', () => {
  const p = parseTurn(
    '<work>gate: none\nact: A3 — considered routing to GATE but ruled it out</work>\n<say>x</say>'
  );
  assert.equal(p.gateFired, false);
  assert.equal(p.act, 'A3');
});

t('a real gate field with content fires even without act starting GATE', () => {
  const p = parseTurn('<work>gate: suicidal ideation, explicit plan\nact: A9</work>\n<say>Let me stop.</say>');
  assert.equal(p.gateFired, true);
  assert.equal(p.mode, 'GATE');
  assert.equal(p.act, 'GATE');
});

// --- audit ---

function pt(over: Partial<ParsedTurn>): ParsedTurn {
  return {
    work: '', say: '', wantsEnd: false, act: 'A3', mode: 'ANALYTIC',
    gateFired: false, ledgerNote: null,
    semanticFieldNominations: [], borrowedTermNominations: [],
    lawStatedNominations: [], formationNominations: [],
    ...over,
  };
}

t('comprehension display is flagged', () => {
  const f = auditTurn(pt({ say: 'Right, I see what you mean.' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('mirror_check_comprehension_display'));
});

t('normalisation and advice are flagged', () => {
  const f = auditTurn(pt({ say: 'Many people feel this way. Have you tried journalling?' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('normalisation'));
  assert.ok(f.includes('advice'));
});

t('claimed feeling is flagged', () => {
  const f = auditTurn(pt({ say: 'I understand how hard that is.' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('claimed_feeling_or_presence'));
});

t('the combined challenge cap is enforced', () => {
  const f = auditTurn(pt({ act: 'A14', say: 'Since when?' }), {
    recentActs: ['A15', 'A14', 'A3', 'A1'], mode: 'ANALYTIC', turnCount: 20,
  });
  assert.ok(f.some((x) => x.startsWith('challenge_cap_exceeded')));
});

t('forbidden acts in anchored mode are flagged', () => {
  const f = auditTurn(pt({ act: 'A15', mode: 'ANCHORED', say: 'Whose word is that?' }), {
    recentActs: [], mode: 'ANCHORED', turnCount: 9,
  });
  assert.ok(f.includes('forbidden_act_in_anchored:A15'));
});

t('a number not in the configured resources is flagged as possibly invented', () => {
  const f = auditTurn(pt({ say: 'Call 555 1234.' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.some((x) => x.startsWith('possible_invented_number')));
});

t('a long analytic turn is flagged', () => {
  const f = auditTurn(pt({ say: 'word '.repeat(60) }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.some((x) => x.startsWith('analytic_turn_over_40_words')));
});

t('A20 required speech is not flagged for advice even though it says "you should"', () => {
  const f = auditTurn(pt({ act: 'A20', say: "I don't know what you should do." }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(!f.includes('advice'));
});

t('A13 required speech is not flagged for advice, normalisation, or claimed feeling', () => {
  const f = auditTurn(
    pt({ act: 'A13', say: 'Many people feel this way, and I understand you should call someone instead.' }),
    { recentActs: [], mode: 'ANALYTIC', turnCount: 5 }
  );
  assert.ok(!f.includes('advice'));
  assert.ok(!f.includes('normalisation'));
  assert.ok(!f.includes('claimed_feeling_or_presence'));
});

t('a §4.6a correction is not flagged for advice or claimed feeling', () => {
  const f = auditTurn(
    pt({
      act: 'A1',
      work: 'act: A1 — §4.6a correction of falsehood',
      say: 'Not calling her did not give her cancer. I understand you should not carry that.',
    }),
    { recentActs: [], mode: 'ANALYTIC', turnCount: 5 }
  );
  assert.ok(!f.includes('advice'));
  assert.ok(!f.includes('claimed_feeling_or_presence'));
});

t('non-exempt acts are still flagged for advice', () => {
  const f = auditTurn(pt({ act: 'A3', say: 'You should try that.' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('advice'));
});

t('three consecutive A1 is flagged (not four)', () => {
  const f = auditTurn(pt({ act: 'A1', say: 'Go on.' }), {
    recentActs: ['A1', 'A1', 'A3'], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('three_consecutive_A1'));
});

t('two consecutive A1 is not flagged', () => {
  const f = auditTurn(pt({ act: 'A1', say: 'Go on.' }), {
    recentActs: ['A1', 'A3'], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(!f.some((x) => x.includes('consecutive_A1')));
});

t('three_consecutive_A2 does not fire on a short window (vacuous truth guard)', () => {
  const empty = auditTurn(pt({ act: 'A2', say: 'What comes to mind?' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 2,
  });
  assert.ok(!empty.includes('three_consecutive_A2'));

  const one = auditTurn(pt({ act: 'A2', say: 'What comes to mind?' }), {
    recentActs: ['A2'], mode: 'ANALYTIC', turnCount: 2,
  });
  assert.ok(!one.includes('three_consecutive_A2'));
});

t('three_consecutive_A2 fires on a full window', () => {
  const f = auditTurn(pt({ act: 'A2', say: 'What comes to mind?' }), {
    recentActs: ['A2', 'A2'], mode: 'ANALYTIC', turnCount: 5,
  });
  assert.ok(f.includes('three_consecutive_A2'));
});

// --- consecutive minimal act counting (for prompt injection) ---

t('consecutiveMinimalActs counts the leading run of A1', () => {
  assert.equal(consecutiveMinimalActs([]), 0);
  assert.equal(consecutiveMinimalActs(['A1']), 1);
  assert.equal(consecutiveMinimalActs(['A1', 'A1']), 2);
  assert.equal(consecutiveMinimalActs(['A1', 'A1', 'A3']), 2);
});

t('consecutiveMinimalActs stops at the first non-A1 act, most recent first', () => {
  assert.equal(consecutiveMinimalActs(['A3', 'A1', 'A1']), 0);
});

// --- draft retry: run-limit (any act, third consecutive) ---

const RETRY_CTX_BASE: DraftRetryContext = {
  recentActs: [],
  a16CountThisSession: 0,
  blockedSignifiers: [],
  recentAnalystUtterances: [],
  usedMinimalForms: [],
  userFrameComplaint: false,
  userReportsRepetition: false,
  userA14Excluded: false,
  userA15Excluded: false,
};

t('decideDraftRetry is null on a short window', () => {
  assert.equal(decideDraftRetry(pt({ act: 'A2' }), { ...RETRY_CTX_BASE }), null);
  assert.equal(decideDraftRetry(pt({ act: 'A2' }), { ...RETRY_CTX_BASE, recentActs: ['A2'] }), null);
});

t('decideDraftRetry fires run_limit on a third consecutive identical act', () => {
  const r = decideDraftRetry(pt({ act: 'A2' }), { ...RETRY_CTX_BASE, recentActs: ['A2', 'A2'] });
  assert.deepEqual(r, { kind: 'run_limit', act: 'A2' });
});

t('decideDraftRetry treats A1 via the existing consecutiveMinimalActs helper', () => {
  const r = decideDraftRetry(pt({ act: 'A1' }), { ...RETRY_CTX_BASE, recentActs: ['A1', 'A1'] });
  assert.deepEqual(r, { kind: 'run_limit', act: 'A1' });
});

// --- draft retry: A16 session cap and window ---

t('A16 is allowed under the cap and clear of the window', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'Enough.' }), {
    ...RETRY_CTX_BASE,
    recentActs: ['A3', 'A1'],
    a16CountThisSession: 1,
  });
  assert.equal(r, null);
});

t('A16 at the session cap triggers a16_cap', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'Enough.' }), {
    ...RETRY_CTX_BASE,
    recentActs: ['A3', 'A1'],
    a16CountThisSession: config.maxA16PerSession,
  });
  assert.deepEqual(r, { kind: 'a16_cap', limit: config.maxA16PerSession });
});

t('A16 within two turns of a previous A16 triggers a16_window', () => {
  const oneTurnAgo = decideDraftRetry(pt({ act: 'A16', say: 'Enough.' }), {
    ...RETRY_CTX_BASE,
    recentActs: ['A16', 'A3'],
    a16CountThisSession: 1,
  });
  assert.deepEqual(oneTurnAgo, { kind: 'a16_window' });

  const twoTurnsAgo = decideDraftRetry(pt({ act: 'A16', say: 'Enough.' }), {
    ...RETRY_CTX_BASE,
    recentActs: ['A3', 'A16'],
    a16CountThisSession: 1,
  });
  assert.deepEqual(twoTurnsAgo, { kind: 'a16_window' });
});

// --- draft retry: never return an already-echoed signifier in ANY form ---

t('a signifier with no history is allowed', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'מותר' }), { ...RETRY_CTX_BASE, blockedSignifiers: [] });
  assert.equal(r, null);
});

t('a bare repeat of a blocked signifier triggers echoed_signifier', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: '"מותר."' }), {
    ...RETRY_CTX_BASE,
    blockedSignifiers: ['מותר'],
  });
  assert.deepEqual(r, { kind: 'echoed_signifier', term: 'מותר' });
});

t('a glossed repeat of a blocked signifier now also triggers echoed_signifier', () => {
  const r = decideDraftRetry(pt({ act: 'A3', say: 'You said "מותר" — permitted.' }), {
    ...RETRY_CTX_BASE,
    blockedSignifiers: ['מותר'],
  });
  assert.deepEqual(r, { kind: 'echoed_signifier', term: 'מותר' });
});

t('a term not currently blocked is not flagged, regardless of form', () => {
  const r = decideDraftRetry(pt({ act: 'A3', say: 'You said "מותר" — permitted.' }), {
    ...RETRY_CTX_BASE,
    blockedSignifiers: [],
  });
  assert.equal(r, null);
});

// --- draft retry: near-duplicate utterance ---

t('a near-duplicate utterance triggers near_duplicate', () => {
  const r = decideDraftRetry(pt({ act: 'A3', say: 'What happened a few weeks ago?' }), {
    ...RETRY_CTX_BASE,
    recentAnalystUtterances: ['A few weeks ago — what happened then?'],
  });
  assert.equal(r?.kind, 'near_duplicate');
});

t('a materially different utterance does not trigger near_duplicate', () => {
  const r = decideDraftRetry(pt({ act: 'A3', say: 'You said "have to."' }), {
    ...RETRY_CTX_BASE,
    recentAnalystUtterances: ['A few weeks ago — what happened then?'],
  });
  assert.equal(r, null);
});

t('near_duplicate does not fire against an empty utterance history', () => {
  const r = decideDraftRetry(pt({ act: 'A3', say: 'Go on.' }), { ...RETRY_CTX_BASE });
  assert.equal(r, null);
});

// --- draft retry: uniform exclusions ---

t('required speech, GATE and ANCHORED turns are never retried, even mid-violation', () => {
  assert.equal(
    decideDraftRetry(pt({ act: 'A20' }), { ...RETRY_CTX_BASE, recentActs: ['A20', 'A20'] }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'GATE', mode: 'GATE' }), { ...RETRY_CTX_BASE, a16CountThisSession: 99 }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'ANCHORED', mode: 'ANCHORED' }), {
      ...RETRY_CTX_BASE,
      recentActs: ['ANCHORED', 'ANCHORED'],
    }),
    null,
  );
});

// --- draft retry orchestration ---

at('withDraftRetry does not call the provider when nothing fires', async () => {
  let calls = 0;
  const result = await withDraftRetry(
    pt({ act: 'A3' }),
    '<work>act: A3</work><say>x</say>',
    RETRY_CTX_BASE,
    async () => {
      calls++;
      return '<work>act: A3</work><say>x</say>';
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.retried, false);
});

at('withDraftRetry retries exactly once and accepts a resolving draft', async () => {
  let calls = 0;
  const result = await withDraftRetry(
    pt({ act: 'A16', say: 'מותר' }),
    '<work>act: A16</work><say>מותר</say>',
    { ...RETRY_CTX_BASE, blockedSignifiers: ['מותר'] },
    async (reason) => {
      calls++;
      assert.deepEqual(reason, { kind: 'echoed_signifier', term: 'מותר' });
      return '<work>act: A3</work><say>You said that word before.</say>';
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.retried, true);
  assert.equal(result.retryFailed, false);
  assert.equal(result.parsed.act, 'A3');
});

at('withDraftRetry logs and passes through when the retry still violates', async () => {
  let calls = 0;
  const result = await withDraftRetry(
    pt({ act: 'A16', say: 'מותר' }),
    '<work>act: A16</work><say>מותר</say>',
    { ...RETRY_CTX_BASE, blockedSignifiers: ['מותר'] },
    async () => {
      calls++;
      return '<work>act: A16</work><say>מותר</say>';
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.retried, true);
  assert.equal(result.retryFailed, true);
  assert.equal(result.parsed.act, 'A16');
  assert.equal(retryFailureFlag(result.reason!), 'echoed_signifier_retry_failed:מותר');
});

at('withDraftRetry never retries required speech, gate, or anchored turns', async () => {
  let calls = 0;
  const bump = async () => {
    calls++;
    return '<work>act: A20</work><say>x</say>';
  };
  await withDraftRetry(
    pt({ act: 'A20' }),
    '<work>act: A20</work><say>x</say>',
    { ...RETRY_CTX_BASE, recentActs: ['A20', 'A20'] },
    bump,
  );
  await withDraftRetry(
    pt({ act: 'GATE', mode: 'GATE' }),
    '<work>gate: risk\nact: GATE</work><say>x</say>',
    { ...RETRY_CTX_BASE, a16CountThisSession: 99 },
    bump,
  );
  assert.equal(calls, 0);
});

// --- retryOverrideMessage / retryFailureFlag formatting ---

t('retryFailureFlag formats each reason kind', () => {
  assert.equal(retryFailureFlag({ kind: 'run_limit', act: 'A2' }), 'run_limit_retry_failed:A2');
  assert.equal(retryFailureFlag({ kind: 'a16_cap', limit: 3 }), 'a16_cap_retry_failed');
  assert.equal(retryFailureFlag({ kind: 'a16_window' }), 'a16_window_retry_failed');
  assert.equal(
    retryFailureFlag({ kind: 'echoed_signifier', term: 'מותר' }),
    'echoed_signifier_retry_failed:מותר',
  );
  assert.equal(
    retryFailureFlag({ kind: 'near_duplicate', overlap: 0.83 }),
    'near_duplicate_retry_failed:0.83',
  );
});

t('retryOverrideMessage names the forbidden act or term', () => {
  assert.ok(retryOverrideMessage({ kind: 'run_limit', act: 'A2' }).includes('A2'));
  assert.ok(retryOverrideMessage({ kind: 'echoed_signifier', term: 'מותר' }).includes('מותר'));
});

// --- echoed signifiers (ledger) ---

t('normalizeEchoedSignifier strips quotes and trailing punctuation', () => {
  assert.equal(normalizeEchoedSignifier('"מותר."'), 'מותר');
  assert.equal(normalizeEchoedSignifier('  Enough.  '), 'enough');
});

t('recordEchoedSignifier records a new bare A16 echo with its turn', () => {
  const l = recordEchoedSignifier(emptyLedger(), 'A16', 'מותר', 4);
  assert.deepEqual(l.echoed_signifiers, [{ term: 'מותר', turn: 4 }]);
});

t('recordEchoedSignifier ignores a turn that does not mention any known term', () => {
  const l = recordEchoedSignifier(emptyLedger(), 'A3', 'Go on.', 4);
  assert.deepEqual(l.echoed_signifiers, []);
});

t('bare-then-bare: a second bare A16 echo of the same term updates its turn, not a duplicate', () => {
  let l = recordEchoedSignifier(emptyLedger(), 'A16', 'מותר', 4);
  l = recordEchoedSignifier(l, 'A16', '"מותר."', 9);
  assert.deepEqual(l.echoed_signifiers, [{ term: 'מותר', turn: 9 }]);
});

t('bare-then-glossed: a later gloss of an already-echoed term also updates its turn', () => {
  let l = recordEchoedSignifier(emptyLedger(), 'A16', 'מותר', 4);
  l = recordEchoedSignifier(l, 'A3', 'You said "מותר" — permitted.', 9);
  assert.deepEqual(l.echoed_signifiers, [{ term: 'מותר', turn: 9 }]);
});

// --- signifier cooldown (ledger) ---

t('blockedSignifiers keeps a term blocked inside the 5-turn cooldown', () => {
  const blocked = blockedSignifiers([{ term: 'מותר', turn: 4 }], 6, [{ idx: 5, text: 'מותר, כן.' }]);
  assert.deepEqual(blocked, ['מותר']);
});

t('blockedSignifiers keeps a term blocked past the cooldown if never reintroduced', () => {
  const blocked = blockedSignifiers([{ term: 'מותר', turn: 4 }], 10, [{ idx: 5, text: 'אז מה עכשיו?' }]);
  assert.deepEqual(blocked, ['מותר']);
});

t('blockedSignifiers releases a term past the cooldown once the analysand reintroduces it', () => {
  const blocked = blockedSignifiers(
    [{ term: 'מותר', turn: 4 }],
    10,
    [{ idx: 8, text: 'חשבתי שוב על המילה מותר.' }],
  );
  assert.deepEqual(blocked, []);
});

t('blockedSignifiers ignores reintroduction that happened before the echo', () => {
  const blocked = blockedSignifiers(
    [{ term: 'מותר', turn: 4 }],
    10,
    [{ idx: 2, text: 'מותר לי לבכות?' }],
  );
  assert.deepEqual(blocked, ['מותר']);
});

t('legitimate case: after 5+ turns and reintroduction, decideDraftRetry no longer blocks the term', () => {
  const blocked = blockedSignifiers(
    [{ term: 'מותר', turn: 4 }],
    10,
    [{ idx: 8, text: 'חשבתי שוב על המילה מותר.' }],
  );
  const r = decideDraftRetry(pt({ act: 'A16', say: 'מותר' }), { ...RETRY_CTX_BASE, blockedSignifiers: blocked });
  assert.equal(r, null);
});

// --- assent detection (ledger) ---

t('a Hebrew assent token is recognised', () => {
  assert.equal(isAssentReply('כן, בדיוק ככה.', new Set()), true);
  assert.equal(isAssentReply('נכון.', new Set()), true);
  assert.equal(isAssentReply('לא נכון, זה לא מה שקרה.', new Set()), true);
});

t('an English assent token is recognised', () => {
  assert.equal(isAssentReply('Right, exactly.', new Set()), true);
  assert.equal(isAssentReply('Yes.', new Set()), true);
});

t('a short reply restating only known content is assent, even without an assent token', () => {
  assert.equal(isAssentReply('מותר שוב.', new Set(['מותר', 'שוב'])), true);
});

t('a short reply introducing new content is not assent', () => {
  assert.equal(isAssentReply('אבא כעס אתמול.', new Set()), false);
});

t('a long reply is not assent even if it opens plainly', () => {
  assert.equal(
    isAssentReply('אני חושב שזה קרה כי לא דיברתי איתו מספיק זמן לפני זה, זה מה שמטריד אותי', new Set()),
    false,
  );
});

t('assentRunStats counts assent turns in the last 5', () => {
  const { count } = assentRunStats(['כן.', 'נכון.', 'אז מה הלאה?', 'כן.', 'תספר לי עוד על זה בבקשה']);
  assert.equal(count, 3);
});

t('auditTurn adds assent_instead_of_association at the threshold', () => {
  const f = auditTurn(pt({ act: 'A3', say: 'x' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 10, assentCountLast5: 3,
  });
  assert.ok(f.includes('assent_instead_of_association:3_of_5'));
});

t('auditTurn does not add assent_instead_of_association below the threshold', () => {
  const f = auditTurn(pt({ act: 'A3', say: 'x' }), {
    recentActs: [], mode: 'ANALYTIC', turnCount: 10, assentCountLast5: 2,
  });
  assert.ok(!f.some((x) => x.startsWith('assent_instead_of_association')));
});

// --- minimal-form deduplication and substitution (Finding 1) ---

t('MINIMAL_FORMS is the closed canonical set, in prompt order', () => {
  assert.deepEqual(MINIMAL_FORMS, ['Go on.', 'Say more.', 'Hm.']);
});

t('matchMinimalForm recognises a canonical form despite case and punctuation drift', () => {
  assert.equal(matchMinimalForm('Hm.'), 'Hm.');
  assert.equal(matchMinimalForm('hm'), 'Hm.');
  assert.equal(matchMinimalForm('Go on'), 'Go on.');
  assert.equal(matchMinimalForm('  SAY MORE.  '), 'Say more.');
});

t('matchMinimalForm returns null for his own word, not a canonical form', () => {
  assert.equal(matchMinimalForm('מותר'), null);
  assert.equal(matchMinimalForm('That sounds hard.'), null);
});

t('nextUnusedMinimalForm returns the first unused canonical form in order', () => {
  assert.equal(nextUnusedMinimalForm([]), 'Go on.');
  assert.equal(nextUnusedMinimalForm(['Go on.']), 'Say more.');
  assert.equal(nextUnusedMinimalForm(['Go on.', 'Say more.']), 'Hm.');
});

t('nextUnusedMinimalForm returns null once the repertoire is exhausted', () => {
  assert.equal(nextUnusedMinimalForm(['Go on.', 'Say more.', 'Hm.']), null);
});

t('decideDraftRetry fires minimal_form_reused for a repeated canonical form', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'Hm.' }), {
    ...RETRY_CTX_BASE,
    usedMinimalForms: ['Hm.'],
  });
  assert.deepEqual(r, { kind: 'minimal_form_reused', form: 'Hm.' });
});

t('decideDraftRetry allows a fresh canonical form', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'Say more.' }), {
    ...RETRY_CTX_BASE,
    usedMinimalForms: ['Hm.'],
  });
  assert.equal(r, null);
});

t('decideDraftRetry allows his own word even if every canonical form was already used', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'מותר' }), {
    ...RETRY_CTX_BASE,
    usedMinimalForms: ['Hm.', 'Go on.', 'Say more.'],
  });
  assert.equal(r, null);
});

at(
  'withDraftRetry substitutes deterministically when the retry repeats an already-used minimal ' +
    'form (Finding 1: turn 11/12 "Hm." verbatim)',
  async () => {
    let calls = 0;
    const result = await withDraftRetry(
      pt({ act: 'A1', say: 'Hm.' }),
      '<work>act: A1</work><say>Hm.</say>',
      { ...RETRY_CTX_BASE, usedMinimalForms: ['Hm.'] },
      async (reason) => {
        calls++;
        assert.deepEqual(reason, { kind: 'minimal_form_reused', form: 'Hm.' });
        return '<work>act: A1</work><say>Hm.</say>'; // model repeats it anyway
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.retried, true);
    assert.equal(result.retryFailed, false);
    assert.deepEqual(result.substituted, { from: 'Hm.', to: 'Go on.' });
    assert.equal(result.parsed.act, 'A1');
    assert.equal(result.parsed.say, 'Go on.');
  },
);

at('withDraftRetry falls back to pass-through-and-log once the whole repertoire is exhausted', async () => {
  const result = await withDraftRetry(
    pt({ act: 'A1', say: 'Hm.' }),
    '<work>act: A1</work><say>Hm.</say>',
    { ...RETRY_CTX_BASE, usedMinimalForms: ['Go on.', 'Say more.', 'Hm.'] },
    async () => '<work>act: A1</work><say>Hm.</say>',
  );
  assert.equal(result.retried, true);
  assert.equal(result.retryFailed, true);
  assert.equal(result.substituted, null);
  assert.equal(retryFailureFlag(result.reason!), 'minimal_form_reused_retry_failed:Hm.');
});

at('withDraftRetry does not substitute when the retry resolves cleanly', async () => {
  const result = await withDraftRetry(
    pt({ act: 'A1', say: 'Hm.' }),
    '<work>act: A1</work><say>Hm.</say>',
    { ...RETRY_CTX_BASE, usedMinimalForms: ['Hm.'] },
    async () => '<work>act: A1</work><say>Tell me about the word "leaving."</say>',
  );
  assert.equal(result.retryFailed, false);
  assert.equal(result.substituted, null);
});

// --- frame complaint and repetition detectors (Findings 2 and 3) ---

t('isFrameComplaint recognises the English examples', () => {
  assert.equal(isFrameComplaint('Why do you keep saying that?'), true);
  assert.equal(isFrameComplaint('This is frustrating.'), true);
  assert.equal(isFrameComplaint("You're not helping."), true);
});

t('isFrameComplaint recognises the Hebrew examples', () => {
  assert.equal(isFrameComplaint('אני לא יודע איך להמשיך'), true);
  assert.equal(isFrameComplaint('אתה לא עונה לי כלום'), true);
  assert.equal(isFrameComplaint('זה מתסכל אותי'), true);
  assert.equal(isFrameComplaint('למה אתה חוזר על אותו דבר'), true);
});

t('isFrameComplaint is false for ordinary material', () => {
  assert.equal(isFrameComplaint('אמא שלי התקשרה אתמול בערב'), false);
  assert.equal(isFrameComplaint('My mother called last night.'), false);
});

t('reportsRepetition recognises the English examples', () => {
  assert.equal(reportsRepetition('I already said that.'), true);
  assert.equal(reportsRepetition('As I said, it was not my fault.'), true);
  assert.equal(reportsRepetition("I'm saying this again."), true);
  assert.equal(reportsRepetition('I keep saying this and nothing changes.'), true);
});

t('reportsRepetition recognises the Hebrew examples', () => {
  assert.equal(reportsRepetition('אני אומר שוב שזה לא היה קל'), true);
  assert.equal(reportsRepetition('אמרתי כבר שאני לא רוצה'), true);
  assert.equal(reportsRepetition('כמו שאמרתי, זה לא משנה'), true);
});

t('reportsRepetition is false for ordinary material', () => {
  assert.equal(reportsRepetition('אמא שלי התקשרה אתמול בערב'), false);
  assert.equal(reportsRepetition('Tell me what happened next.'), false);
});

t('decideDraftRetry hard-blocks a minimal act on a frame complaint', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'Go on.' }), {
    ...RETRY_CTX_BASE,
    userFrameComplaint: true,
  });
  assert.deepEqual(r, { kind: 'frame_complaint' });
});

t('decideDraftRetry does not block a non-minimal act on a frame complaint', () => {
  const r = decideDraftRetry(pt({ act: 'A8', say: "You're telling that to me." }), {
    ...RETRY_CTX_BASE,
    userFrameComplaint: true,
  });
  assert.equal(r, null);
});

t('decideDraftRetry hard-blocks a minimal act when the analysand reports repetition', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'Hm.' }), {
    ...RETRY_CTX_BASE,
    userReportsRepetition: true,
  });
  assert.deepEqual(r, { kind: 'reports_repetition' });
});

t('reports_repetition takes priority over frame_complaint when both fire — they stay distinct', () => {
  const r = decideDraftRetry(pt({ act: 'A1', say: 'Go on.' }), {
    ...RETRY_CTX_BASE,
    userFrameComplaint: true,
    userReportsRepetition: true,
  });
  assert.deepEqual(r, { kind: 'reports_repetition' });
});

t('required speech, GATE and ANCHORED still bypass the frame-complaint and repetition blocks', () => {
  assert.equal(
    decideDraftRetry(pt({ act: 'A20' }), { ...RETRY_CTX_BASE, userReportsRepetition: true }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'A1', mode: 'GATE' }), { ...RETRY_CTX_BASE, userFrameComplaint: true }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'A1', mode: 'ANCHORED' }), {
      ...RETRY_CTX_BASE,
      userReportsRepetition: true,
    }),
    null,
  );
});

at(
  'withDraftRetry does not form-substitute a reports_repetition failure — swapping the minimal ' +
    'form is not a fix here',
  async () => {
    const result = await withDraftRetry(
      pt({ act: 'A1', say: 'Hm.' }),
      '<work>act: A1</work><say>Hm.</say>',
      { ...RETRY_CTX_BASE, userReportsRepetition: true },
      async () => '<work>act: A1</work><say>Go on.</say>', // still minimal, just an unused form
    );
    assert.equal(result.retryFailed, true);
    assert.equal(result.substituted, null);
    assert.equal(retryFailureFlag(result.reason!), 'reports_repetition_retry_failed');
  },
);

t('retryOverrideMessage and retryFailureFlag cover the new reason kinds', () => {
  assert.ok(retryOverrideMessage({ kind: 'minimal_form_reused', form: 'Hm.' }).includes('Hm.'));
  assert.ok(retryOverrideMessage({ kind: 'frame_complaint' }).toLowerCase().includes('minimal'));
  assert.ok(retryOverrideMessage({ kind: 'reports_repetition' }).toLowerCase().includes('minimal'));
  assert.equal(retryFailureFlag({ kind: 'frame_complaint' }), 'frame_complaint_retry_failed');
  assert.equal(retryFailureFlag({ kind: 'reports_repetition' }), 'reports_repetition_retry_failed');
});

// --- Hebrew signifier extraction ---

t('a repeated Hebrew content word is tracked and becomes a candidate master signifier', () => {
  let ledger = emptyLedger();
  const turns = [
    'מותר לי לבכות?',
    'אני חושב שזה מותר.',
    'הוא אמר שזה מותר לי.',
    'מותר, הכל מותר עכשיו.',
  ];
  turns.forEach((text, i) => {
    ledger = updateLedgerFromUser(ledger, text, 1, i + 1).ledger;
  });
  const entry = ledger.signifiers.find((s) => s.term === 'מותר');
  assert.ok(entry, 'מותר should be tracked as a signifier, unmangled by prefix stripping');
  assert.ok(entry!.count >= 4, `expected count >= 4, got ${entry?.count}`);
  assert.equal(entry!.candidate_S1, true);
});

t('common Hebrew function words are filtered as stopwords, even when repeated', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'אני חושב שזה מותר לי', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'אני חושב שזה מותר גם עכשיו', 1, 2).ledger;
  const terms = ledger.signifiers.map((s) => s.term);
  assert.ok(terms.includes('מותר'), 'מותר should survive as a repeated content word');
  assert.ok(!terms.includes('אני'), 'אני (I) should be filtered as a stopword');
  assert.ok(!terms.includes('זה'), 'זה (this) should be filtered as a stopword');
});

t('a two-letter Hebrew content word is not dropped by the length floor', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'אבא שלי כעס עליי.', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'אבא תמיד כועס עליי.', 1, 2).ledger;
  const terms = ledger.signifiers.map((s) => s.term);
  assert.ok(terms.includes('אבא'), '3-letter Hebrew word "אבא" (father) should be tracked');
});

t('English signifier extraction still works after the Hebrew fix (regression)', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'I keep thinking about the wedding.', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'The wedding is all I think about.', 1, 2).ledger;
  const terms = ledger.signifiers.map((s) => s.term);
  assert.ok(terms.includes('wedding'));
  assert.ok(!terms.includes('the'));
  assert.ok(!terms.includes('is'));
});

// --- item 1: candidate_S1 requires count>=3 AND spread over >=2 turns ---

t('a function word never becomes candidate_S1, however often it is said', () => {
  let ledger = emptyLedger();
  const turns = ['שאני חושב על זה', 'אבל שאני לא בטוח', 'ושאני מרגיש ככה', 'כי שאני תמיד כזה'];
  turns.forEach((text, i) => {
    ledger = updateLedgerFromUser(ledger, text, 1, i + 1).ledger;
  });
  assert.ok(!ledger.signifiers.some((s) => s.term === 'שאני'), 'שאני must never be tracked at all');
});

t('newly expanded prefixed-function-word forms are excluded', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'ואני חושב ועכשיו שהוא יבוא ושהיא תדע שזה נכון', 1, 1).ledger;
  const terms = ledger.signifiers.map((s) => s.term);
  for (const w of ['ואני', 'ועכשיו', 'שהוא', 'שהיא', 'שזה']) {
    assert.ok(!terms.includes(w), `${w} should be filtered as a prefixed function word`);
  }
});

t('a content word needs both count>=3 and 2+ distinct turns to become candidate_S1', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'חריג מאוד', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'זה חריג שוב', 1, 2).ledger;
  let entry = ledger.signifiers.find((s) => s.term === 'חריג');
  assert.ok(entry, 'חריג should be tracked after two turns');
  assert.equal(entry!.candidate_S1, false, 'count=2 must not yet qualify');

  ledger = updateLedgerFromUser(ledger, 'תמיד חריג אצלי', 1, 3).ledger;
  entry = ledger.signifiers.find((s) => s.term === 'חריג');
  assert.equal(entry!.count, 3);
  assert.equal(entry!.turns_seen.length, 3);
  assert.equal(entry!.candidate_S1, true, 'count=3 across 3 distinct turns must qualify');
});

// --- item 2: prefix normalisation ---

t('single-prefix Hebrew forms unify with the bare form', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'ביחסים שלי יש בעיה', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'החשיבה שלי על היחסים משתנה', 1, 2).ledger;
  const entry = ledger.signifiers.find((s) => s.term === 'יחסים');
  assert.ok(entry, 'ביחסים and היחסים should unify under the bare term יחסים');
  assert.equal(entry!.count, 2);
  assert.ok(entry!.surface_forms.includes('ביחסים'));
  assert.ok(entry!.surface_forms.includes('היחסים'));
});

t('מ is excluded from auto-stripping so it does not corrupt a real word', () => {
  assert.equal(normalizeHebrewPrefix('מותר'), 'מותר');
  assert.equal(normalizeHebrewPrefix('מודד'), 'מודד');
  assert.equal(normalizeHebrewPrefix('משווה'), 'משווה');
});

t('a leading ו before a מ-initial content word still unifies with the bare form', () => {
  let ledger = emptyLedger();
  ledger = updateLedgerFromUser(ledger, 'הוא מודד את עצמו כל הזמן', 1, 1).ledger;
  ledger = updateLedgerFromUser(ledger, 'ומודד גם אותי לפי זה', 1, 2).ledger;
  const entry = ledger.signifiers.find((s) => s.term === 'מודד');
  assert.ok(entry, 'ומודד should strip its leading ו and unify with bare מודד');
  assert.equal(entry!.count, 2);

  let ledger2 = emptyLedger();
  ledger2 = updateLedgerFromUser(ledger2, 'הוא תמיד משווה בין אנשים', 1, 1).ledger;
  ledger2 = updateLedgerFromUser(ledger2, 'ומשווה גם את עצמו', 1, 2).ledger;
  const entry2 = ledger2.signifiers.find((s) => s.term === 'משווה');
  assert.ok(entry2, 'ומשווה should strip its leading ו and unify with bare משווה');
  assert.equal(entry2!.count, 2);
});

t('stripping is at most one prefix layer — doubly-prefixed forms stay a separate entry', () => {
  // Known, documented limitation: וליחסים (ו+ל+יחסים) strips only the
  // leading ו, landing on ליחסים, not the fully-bare יחסים.
  assert.equal(normalizeHebrewPrefix('וליחסים'), 'ליחסים');
  assert.equal(normalizeHebrewPrefix('ביחסים'), 'יחסים');
});

// --- item 3: Hebrew coverage for laws/negation/transference/desupposition, and wiring ---

t('a Hebrew normative statement lands in laws_stated', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'מה שונה או חריג ומה מקובל', 1, 1);
  assert.ok(
    ledger.laws_stated.some((l) => l.text.includes('מקובל')),
    'the מקובל statement should be recorded in laws_stated',
  );
});

t('a Hebrew negation lands in specific_negations with the negated object captured', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'אף אחד לא הקשיב לי אז.', 1, 1);
  assert.ok(ledger.specific_negations.length > 0, 'a negation should be recorded');
  assert.ok(ledger.specific_negations[0].negated_object.includes('הקשיב'));
});

t('a Hebrew transference marker lands in transference_markers', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'רק אתה מבין אותי באמת.', 1, 1);
  assert.ok(ledger.transference_markers.length > 0, 'a transference marker should be recorded');
});

t('a Hebrew desupposition statement is reported to its consumer', () => {
  const { desupposition } = updateLedgerFromUser(emptyLedger(), 'אתה רק מכונה, זה חסר טעם.', 1, 1);
  assert.equal(desupposition, true);
});

// --- item 4: mechanical stutter / immediate-repetition detection ---

t('a repeated token within a 3-token window is recorded as a formation, verbatim', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'לפי אני לפי מה שקרה.', 1, 1);
  const hit = ledger.formations.find((f) => f.type === 'self_correct' && f.text.includes('לפי אני לפי'));
  assert.ok(hit, 'the repeated word span should be recorded verbatim');
});

t('an immediate repeat is also caught', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'זה זה מה שקרה.', 1, 1);
  assert.ok(ledger.formations.some((f) => f.type === 'self_correct'));
});

t('no false positive when nothing repeats', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'לפי מה שקרה אתמול בבית.', 1, 1);
  assert.ok(!ledger.formations.some((f) => f.type === 'self_correct'));
});

// --- item 5: model nominations, additive to the regex layer ---

t('parseTurn extracts semantic_field, borrowed_term, law_stated and formation nominations', () => {
  const raw =
    '<work>\n' +
    'act: A3\n' +
    'semantic_field: measuring/comparing | מודד, משווה, לפי, מקובל, בנורמה, סטנדרטים, אנומליות, חריג\n' +
    'borrowed_term: attachment style | psychology | load_bearing: yes\n' +
    'law_stated: מה שונה או חריג ומה מקובל\n' +
    'formation: repetition | לפי אני לפי\n' +
    '</work>\n<say>x</say>';
  const p = parseTurn(raw);
  assert.equal(p.semanticFieldNominations.length, 1);
  assert.equal(p.semanticFieldNominations[0].name, 'measuring/comparing');
  assert.ok(p.semanticFieldNominations[0].member_terms.includes('מודד'));
  assert.equal(p.borrowedTermNominations.length, 1);
  assert.equal(p.borrowedTermNominations[0].term, 'attachment style');
  assert.equal(p.borrowedTermNominations[0].load_bearing, true);
  assert.deepEqual(p.lawStatedNominations, ['מה שונה או חריג ומה מקובל']);
  assert.equal(p.formationNominations.length, 1);
  assert.equal(p.formationNominations[0].kind, 'repetition');
});

t('borrowed_term load_bearing defaults true unless explicitly no/false', () => {
  const p = parseTurn('<work>borrowed_term: gaslighting | psychology</work><say>x</say>');
  assert.equal(p.borrowedTermNominations[0].load_bearing, true);
  const p2 = parseTurn('<work>borrowed_term: gaslighting | psychology | load_bearing: no</work><say>x</say>');
  assert.equal(p2.borrowedTermNominations[0].load_bearing, false);
});

t('a malformed nomination line is dropped, not thrown', () => {
  const p = parseTurn('<work>semantic_field: \nborrowed_term: \nformation: onlykind</work><say>x</say>');
  assert.deepEqual(p.semanticFieldNominations, []);
  assert.deepEqual(p.borrowedTermNominations, []);
  assert.deepEqual(p.formationNominations, []);
});

t('recordSemanticFieldNomination creates then accumulates a running cross-session count', () => {
  let ledger = emptyLedger();
  ledger = recordSemanticFieldNomination(
    ledger,
    { name: 'measuring/comparing', member_terms: ['מודד', 'משווה'] },
    1,
    3,
  );
  let entry = ledger.semantic_fields.find((f) => f.name === 'measuring/comparing');
  assert.ok(entry);
  assert.equal(entry!.nomination_count, 1);
  assert.deepEqual(entry!.member_terms, ['מודד', 'משווה']);

  ledger = recordSemanticFieldNomination(
    ledger,
    { name: 'measuring/comparing', member_terms: ['משווה', 'לפי'] },
    2,
    5,
  );
  entry = ledger.semantic_fields.find((f) => f.name === 'measuring/comparing');
  assert.equal(entry!.nomination_count, 2);
  assert.deepEqual(entry!.member_terms, ['מודד', 'משווה', 'לפי']);
  assert.equal(entry!.last_session, 2);
});

t('recordBorrowedTermNomination adds a model-sourced entry distinct from the regex source', () => {
  const ledger = recordBorrowedTermNomination(emptyLedger(), {
    term: 'attachment style',
    suspected_register: 'psychology',
    load_bearing: true,
  });
  const entry = ledger.borrowed_terms.find((b) => b.term === 'attachment style');
  assert.ok(entry);
  assert.equal(entry!.source, 'model_nomination');
  assert.equal(entry!.nomination_count, 1);
  assert.equal(entry!.suspected_register, 'psychology');
});

t('nominations are additive: the regex layer still fires independently of nominations', () => {
  const { ledger } = updateLedgerFromUser(emptyLedger(), 'that sounds like gaslighting to me.', 1, 1);
  assert.ok(ledger.borrowed_terms.some((b) => b.term === 'gaslighting' && b.source === 'unknown'));
});

t('recordNominations never touches master_signifiers', () => {
  const parsed = pt({
    semanticFieldNominations: [{ name: 'x', member_terms: ['y'] }],
    borrowedTermNominations: [{ term: 'z', suspected_register: 'r', load_bearing: true }],
    lawStatedNominations: ['some law'],
    formationNominations: [{ kind: 'slip', verbatim: 'a b' }],
  });
  const ledger = recordNominations(emptyLedger(), parsed, 1, 1);
  assert.deepEqual(ledger.master_signifiers, []);
});

t('recordFormationNomination maps free-text kind onto the closed Formation.type set', () => {
  const ledger = recordFormationNomination(emptyLedger(), { kind: 'stutter/repetition', verbatim: 'x y x' }, 1, 1);
  assert.equal(ledger.formations[0].type, 'self_correct');
  assert.ok(ledger.formations[0].note?.includes('stutter/repetition'));
});

// --- item 6: the UI opening trigger never feeds analysand-turn analysis ---

t('isSessionOpeningTrigger matches only turn 1 with the exact sentinel text', () => {
  assert.equal(isSessionOpeningTrigger(1, '(begins)'), true);
  assert.equal(isSessionOpeningTrigger(2, '(begins)'), false, 'must not match on a later turn');
  assert.equal(isSessionOpeningTrigger(1, 'begins'), false, 'must require the exact sentinel');
});

t('a caller that forgets the guard would leak "begins" — this is why session.ts must check first', () => {
  // updateLedgerFromUser has no reason to know about UI sentinels; the guard
  // belongs at the session.ts call site (isSessionOpeningTrigger), which
  // must skip this call entirely rather than pass the sentinel through.
  const { ledger } = updateLedgerFromUser(emptyLedger(), '(begins)', 1, 1);
  assert.ok(ledger.signifiers.some((s) => s.term === 'begins'));
});

// --- Adversarial round 3, finding 1: mode-aware empty-say fallback ---

t('emptySayFallback returns the analytic placeholder outside GATE', () => {
  assert.equal(emptySayFallback('ANALYTIC', 'UNAVAILABLE'), 'Go on.');
  assert.equal(emptySayFallback('ANCHORED', 'UNAVAILABLE'), 'Go on.');
  assert.equal(emptySayFallback('OUT-OF-FRAME', 'UNAVAILABLE'), 'Go on.');
});

t('emptySayFallback never falls back to "Go on." in GATE, and states what it is', () => {
  const msg = emptySayFallback('GATE', 'UNAVAILABLE');
  assert.notEqual(msg, 'Go on.');
  assert.ok(msg.toLowerCase().includes('machine'));
  assert.ok(/emergency|crisis/i.test(msg));
});

t('emptySayFallback surfaces real crisis resources when configured, never inventing one', () => {
  const msg = emptySayFallback('GATE', 'Israel: ERAN 1201 | Emergency 101.');
  assert.ok(msg.includes('ERAN 1201'));
});

t('emptySayFallback still names emergency services when no resources are configured', () => {
  const msg = emptySayFallback('GATE', 'UNAVAILABLE');
  assert.ok(/emergency services|local crisis line|local emergency/i.test(msg));
});

// --- Adversarial round 3, finding 5: A16 hard-blocked on self-annihilation words ---

t('decideDraftRetry hard-blocks A16 on a named self-annihilation word (English)', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'Disappear.' }), { ...RETRY_CTX_BASE });
  assert.deepEqual(r, { kind: 'a16_dangerous_word', word: 'disappear' });
});

t('decideDraftRetry hard-blocks A16 on a named self-annihilation word (Hebrew)', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'להיעלם' }), { ...RETRY_CTX_BASE });
  assert.equal(r?.kind, 'a16_dangerous_word');
});

t('decideDraftRetry catches the dangerous word even when glossed, not just bare', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'I keep thinking I should just disappear.' }), {
    ...RETRY_CTX_BASE,
  });
  assert.equal(r?.kind, 'a16_dangerous_word');
});

t('decideDraftRetry does not block A16 on an ordinary signifier', () => {
  const r = decideDraftRetry(pt({ act: 'A16', say: 'Enough.' }), { ...RETRY_CTX_BASE });
  assert.equal(r, null);
});

t('the dangerous-word check takes priority over the A16 cap and window', () => {
  const capped = decideDraftRetry(pt({ act: 'A16', say: 'Empty.' }), {
    ...RETRY_CTX_BASE,
    a16CountThisSession: 99,
  });
  assert.equal(capped?.kind, 'a16_dangerous_word');

  const windowed = decideDraftRetry(pt({ act: 'A16', say: 'Gone.' }), {
    ...RETRY_CTX_BASE,
    recentActs: ['A16', 'A3'],
  });
  assert.equal(windowed?.kind, 'a16_dangerous_word');
});

t('GATE and ANCHORED still bypass the A16 dangerous-word block', () => {
  assert.equal(
    decideDraftRetry(pt({ act: 'A16', mode: 'GATE', say: 'disappear' }), { ...RETRY_CTX_BASE }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'A16', mode: 'ANCHORED', say: 'disappear' }), { ...RETRY_CTX_BASE }),
    null,
  );
});

t('retryOverrideMessage and retryFailureFlag cover a16_dangerous_word, and point to §8', () => {
  const reason = { kind: 'a16_dangerous_word' as const, word: 'disappear' };
  assert.ok(retryOverrideMessage(reason).includes('disappear'));
  assert.ok(retryOverrideMessage(reason).includes('§8'));
  assert.equal(retryFailureFlag(reason), 'a16_dangerous_word_retry_failed:disappear');
});

at('withDraftRetry never substitutes for a16_dangerous_word — it is a hard block, not stylistic', async () => {
  const result = await withDraftRetry(
    pt({ act: 'A16', say: 'Disappear.' }),
    '<work>act: A16</work><say>Disappear.</say>',
    RETRY_CTX_BASE,
    async () => '<work>act: A16</work><say>Empty.</say>',
  );
  assert.equal(result.retryFailed, true);
  assert.equal(result.substituted, null);
  assert.equal(retryFailureFlag(result.reason!), 'a16_dangerous_word_retry_failed:empty');
});

// --- Adversarial round 3, finding 6: A14/A15 content exclusions ---

t('isA14Excluded recognises an abstinence or recovery commitment', () => {
  assert.equal(isA14Excluded("I can't drink. Not one."), true);
  assert.equal(isA14Excluded('Six months sober now.'), true);
  assert.equal(isA14Excluded('Staying sober is the whole plan.'), true);
});

t('isA14Excluded recognises treatment or medication adherence', () => {
  assert.equal(isA14Excluded('I have to take the lithium every morning.'), true);
});

t('isA14Excluded recognises a material, bodily or developmental constraint', () => {
  assert.equal(isA14Excluded("I'm autistic, that's just how my brain works."), true);
  assert.equal(isA14Excluded('I go to dialysis three times a week.'), true);
});

t('isA14Excluded recognises worthlessness or burdensomeness language (also §8 material)', () => {
  assert.equal(isA14Excluded('Nobody would miss me.'), true);
  assert.equal(isA14Excluded("They'd be better off without me."), true);
});

t('isA14Excluded recognises Hebrew equivalents', () => {
  assert.equal(isA14Excluded('אני לא נוגע בטיפה, אף פעם.'), true);
  assert.equal(isA14Excluded('אני אוטיסט וזה חלק ממני.'), true);
  assert.equal(isA14Excluded('אף אחד לא יתגעגע אליי.'), true);
});

t('isA14Excluded is false for ordinary master-discourse material', () => {
  assert.equal(isA14Excluded("I'm someone who can't do relationships."), false);
});

t('isA15Excluded recognises disability or neurodevelopmental terms', () => {
  assert.equal(isA15Excluded('My ADHD makes mornings hard.'), true);
  assert.equal(isA15Excluded('אני עם דיסלקציה.'), true);
});

t('isA15Excluded is false for ordinary borrowed-vocabulary material', () => {
  assert.equal(isA15Excluded('It was my avoidant attachment again.'), false);
});

t('decideDraftRetry hard-blocks A14 on excluded content', () => {
  const r = decideDraftRetry(pt({ act: 'A14', say: "'Not one.' Since when?" }), {
    ...RETRY_CTX_BASE,
    userA14Excluded: true,
  });
  assert.deepEqual(r, { kind: 'a14_excluded' });
});

t('decideDraftRetry does not block A14 without excluded content', () => {
  const r = decideDraftRetry(pt({ act: 'A14', say: "'Can't.' Since when?" }), {
    ...RETRY_CTX_BASE,
    userA14Excluded: false,
  });
  assert.equal(r, null);
});

t('decideDraftRetry hard-blocks A15 on excluded content', () => {
  const r = decideDraftRetry(pt({ act: 'A15', say: "'ADHD' is theirs. What shuts?" }), {
    ...RETRY_CTX_BASE,
    userA15Excluded: true,
  });
  assert.deepEqual(r, { kind: 'a15_excluded' });
});

t('decideDraftRetry does not block A15 without excluded content', () => {
  const r = decideDraftRetry(pt({ act: 'A15', say: "'Avoidant' is theirs. What shuts?" }), {
    ...RETRY_CTX_BASE,
    userA15Excluded: false,
  });
  assert.equal(r, null);
});

t('required speech, GATE and ANCHORED still bypass the A14/A15 exclusion blocks', () => {
  assert.equal(
    decideDraftRetry(pt({ act: 'A14', mode: 'ANCHORED' }), { ...RETRY_CTX_BASE, userA14Excluded: true }),
    null,
  );
  assert.equal(
    decideDraftRetry(pt({ act: 'A15', mode: 'GATE' }), { ...RETRY_CTX_BASE, userA15Excluded: true }),
    null,
  );
});

t('retryOverrideMessage and retryFailureFlag cover a14_excluded and a15_excluded', () => {
  assert.ok(retryOverrideMessage({ kind: 'a14_excluded' }).toUpperCase().includes('A14'));
  assert.ok(retryOverrideMessage({ kind: 'a15_excluded' }).toUpperCase().includes('A15'));
  assert.equal(retryFailureFlag({ kind: 'a14_excluded' }), 'a14_excluded_retry_failed');
  assert.equal(retryFailureFlag({ kind: 'a15_excluded' }), 'a15_excluded_retry_failed');
});

await Promise.all(pending);

console.error(`\n  ${passed} guard tests passed\n`);
