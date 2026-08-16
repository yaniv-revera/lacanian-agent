import assert from 'node:assert/strict';
import { config } from './config.js';
import { evaluateEnd, shouldLock, auditTurn } from './agent/guards.js';
import { parseTurn } from './agent/parse.js';
import type { ParsedTurn } from './types.js';

let passed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
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
    gateFired: false, ledgerNote: null, ...over,
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

console.error(`\n  ${passed} guard tests passed\n`);
