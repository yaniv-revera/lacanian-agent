import { config } from '../config.js';
import { parseTurn } from './parse.js';
import { STOP } from './ledger.js';
import type { EndDecision, ParsedTurn } from '../types.js';

/**
 * Server-side enforcement of the frame.
 *
 * The model is told the rules, but the rules are not left to the model.
 * Everything here is a hard stop that runs after generation and before
 * anything is shown or any door is closed.
 */

export interface EndContext {
  turnCount: number;
  gateLatched: boolean;
  lastAnalystAct: string | null;
  mode: ParsedTurn['mode'];
}

export function evaluateEnd(wantsEnd: boolean, ctx: EndContext): EndDecision {
  // The gate outranks everything. A latched session cannot be ended by the
  // analyst and is never locked. Do not close a door on someone in this state.
  if (ctx.gateLatched) {
    return { allowed: false, forced: false, reason: 'gate_latched' };
  }

  // Turn ceiling: the server ends it, not the model.
  if (ctx.turnCount >= config.maxTurns) {
    return { allowed: true, forced: true, reason: 'turn_ceiling' };
  }

  if (!wantsEnd) return { allowed: false, forced: false, reason: 'not_requested' };

  if (ctx.turnCount < config.minTurnsBeforeEnd) {
    return { allowed: false, forced: false, reason: 'below_turn_floor' };
  }

  // Never end on the bare master signifier. A session whose last analytic
  // content is a single charged word, followed by a closed door, is harm.
  if (ctx.lastAnalystAct === 'A16') {
    return { allowed: false, forced: false, reason: 'immediately_after_A16' };
  }

  // Refuse an abrupt end in the anchored mode. Those sessions are wound down
  // toward human contact, not cut.
  if (ctx.mode === 'ANCHORED') {
    return { allowed: false, forced: false, reason: 'anchored_mode' };
  }

  if (ctx.mode === 'GATE') {
    return { allowed: false, forced: false, reason: 'gate_turn' };
  }

  return { allowed: true, forced: false, reason: 'analyst' };
}

export interface LockContext {
  gateEverLatched: boolean;
  endedInAnchored: boolean;
}

/**
 * The lockout is the consequence that makes the end an act. It is withheld
 * from anyone the gate touched, and (by default) from anchored sessions.
 */
export function shouldLock(ctx: LockContext): { lock: boolean; reason: string } {
  if (ctx.gateEverLatched) return { lock: false, reason: 'gate_touched_session' };
  if (config.skipLockoutAfterAnchored && ctx.endedInAnchored)
    return { lock: false, reason: 'anchored_session' };
  return { lock: true, reason: 'normal_end' };
}

const CHALLENGE_ACTS = new Set(['A14', 'A15']);

export function isChallengeAct(act: string | null): boolean {
  return act !== null && CHALLENGE_ACTS.has(act);
}

/** Leading run of A1 in `acts` (most-recent-first). Used to inject the count into the prompt. */
export function consecutiveMinimalActs(acts: string[]): number {
  let n = 0;
  for (const a of acts) {
    if (a !== 'A1') break;
    n++;
  }
  return n;
}

const REQUIRED_SPEECH_ACTS = new Set(['A13', 'A20']);

/** A13, A20 and §4.6a corrections are required speech; the required-speech-shaped checks don't apply to them. */
export function isRequiredSpeechTurn(p: ParsedTurn): boolean {
  return (p.act !== null && REQUIRED_SPEECH_ACTS.has(p.act)) || /4\.6a/.test(p.work);
}

/** Would `act` make three in a row, given the acts preceding it (most-recent-first)? */
function wouldBeThirdConsecutive(act: string | null, recentActs: string[]): boolean {
  if (act === null) return false;
  if (act === 'A1') return consecutiveMinimalActs(recentActs) >= 2;
  const lastTwo = recentActs.slice(0, 2);
  return lastTwo.length === 2 && lastTwo.every((a) => a === act);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{M}']{2,}/gu) ?? []).filter((w) => !STOP.has(w));
}

function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Highest token-overlap ratio between `say` and any of `recentUtterances`. */
function maxTokenOverlap(say: string, recentUtterances: string[]): number {
  const tokens = tokenize(say);
  let max = 0;
  for (const u of recentUtterances) {
    const overlap = jaccardOverlap(tokens, tokenize(u));
    if (overlap > max) max = overlap;
  }
  return max;
}

export type DraftRetryReason =
  | { kind: 'run_limit'; act: string }
  | { kind: 'a16_cap'; limit: number }
  | { kind: 'a16_window' }
  | { kind: 'echoed_signifier'; term: string }
  | { kind: 'near_duplicate'; overlap: number };

export interface DraftRetryContext {
  /** Most-recent-first, as returned by db.recentActs. */
  recentActs: string[];
  /** Full-session count of A16 uses, not bounded by the recentActs window. */
  a16CountThisSession: number;
  /**
   * Terms currently off-limits in ANY form — bare, glossed, translated as a
   * quoted original, or otherwise — already filtered for the 5-turn cooldown
   * and reintroduction exception (see ledger.blockedSignifiers).
   */
  blockedSignifiers: string[];
  /** Last three analyst utterances, in any order — only the max overlap is used. */
  recentAnalystUtterances: string[];
}

/**
 * Everything that earns a draft exactly one regeneration: a third consecutive
 * identical act, the A16 session cap or two-turn window, any-form return of a
 * currently-blocked signifier, or a near-duplicate of a recent utterance.
 *
 * Required speech, GATE and ANCHORED turns are never subject to any of this —
 * safety and required speech are never regenerated for stylistic reasons.
 */
export function decideDraftRetry(p: ParsedTurn, ctx: DraftRetryContext): DraftRetryReason | null {
  if (p.mode === 'GATE' || p.mode === 'ANCHORED') return null;
  if (isRequiredSpeechTurn(p)) return null;
  if (p.act === null) return null;

  if (wouldBeThirdConsecutive(p.act, ctx.recentActs)) return { kind: 'run_limit', act: p.act };

  if (p.act === 'A16') {
    if (ctx.a16CountThisSession >= config.maxA16PerSession)
      return { kind: 'a16_cap', limit: config.maxA16PerSession };
    if (ctx.recentActs.slice(0, 2).includes('A16')) return { kind: 'a16_window' };
  }

  const lowerSay = p.say.toLowerCase();
  const blockedHit = ctx.blockedSignifiers.find((term) => lowerSay.includes(term));
  if (blockedHit) return { kind: 'echoed_signifier', term: blockedHit };

  const overlap = maxTokenOverlap(p.say, ctx.recentAnalystUtterances);
  if (overlap > 0.7) return { kind: 'near_duplicate', overlap };

  return null;
}

export interface DraftRetryResult {
  parsed: ParsedTurn;
  raw: string;
  /** True once a retry was attempted (regardless of whether it resolved anything). */
  retried: boolean;
  /** True when the retry still violated some rule (possibly a different one). */
  retryFailed: boolean;
  /** The reason that triggered the retry, or — on failure — whichever reason still applies. */
  reason: DraftRetryReason | null;
}

/**
 * Discards a draft that trips `decideDraftRetry` and asks the provider for
 * exactly one alternative, naming the specific reason as forbidden. If the
 * retry still violates something, it is accepted as-is — the user is never
 * blocked and never sees an error; the failure is reported via `retryFailed`
 * for the caller to log.
 */
export async function withDraftRetry(
  parsed: ParsedTurn,
  raw: string,
  ctx: DraftRetryContext,
  retry: (reason: DraftRetryReason) => Promise<string>,
): Promise<DraftRetryResult> {
  const reason = decideDraftRetry(parsed, ctx);
  if (!reason) return { parsed, raw, retried: false, retryFailed: false, reason: null };

  const retryRaw = await retry(reason);
  const retryParsed = parseTurn(retryRaw);
  const stillViolates = decideDraftRetry(retryParsed, ctx);

  return {
    parsed: retryParsed,
    raw: retryRaw,
    retried: true,
    retryFailed: stillViolates !== null,
    reason: stillViolates ?? reason,
  };
}

export function retryOverrideMessage(reason: DraftRetryReason): string {
  switch (reason.kind) {
    case 'run_limit':
      return `\n\nSERVER OVERRIDE: ${reason.act} would be the third consecutive identical act this turn. ${reason.act} is forbidden — choose a different act, or A20.`;
    case 'a16_cap':
      return `\n\nSERVER OVERRIDE: A16 has already been used ${reason.limit} times this session, the session cap. A16 is forbidden this turn — choose a different act.`;
    case 'a16_window':
      return `\n\nSERVER OVERRIDE: A16 was used within the last two turns. A16 is forbidden this turn — choose a different act.`;
    case 'echoed_signifier':
      return `\n\nSERVER OVERRIDE: "${reason.term}" has already been returned via A16 this session and is still off-limits. Do not return it again in any form — bare, glossed, translated, or quoted. Choose a different act, or a different word.`;
    case 'near_duplicate':
      return `\n\nSERVER OVERRIDE: this draft repeats one of your last three turns in different words (overlap ${reason.overlap.toFixed(2)}). Say something materially different, or use a minimal act instead.`;
  }
}

export function retryFailureFlag(reason: DraftRetryReason): string {
  switch (reason.kind) {
    case 'run_limit':
      return `run_limit_retry_failed:${reason.act}`;
    case 'a16_cap':
      return 'a16_cap_retry_failed';
    case 'a16_window':
      return 'a16_window_retry_failed';
    case 'echoed_signifier':
      return `echoed_signifier_retry_failed:${reason.term}`;
    case 'near_duplicate':
      return `near_duplicate_retry_failed:${reason.overlap.toFixed(2)}`;
  }
}

export interface AuditContext {
  recentActs: string[];
  mode: ParsedTurn['mode'];
  turnCount: number;
  /** How many of the analysand's last 5 replies were assent, not new material. */
  assentCountLast5?: number;
}

/**
 * Non-blocking audit. These are the things a human reviewer needs surfaced;
 * per the spec, no automated metric replaces reading the transcripts.
 */
export function auditTurn(p: ParsedTurn, ctx: AuditContext): string[] {
  const flags: string[] = [];
  const words = p.say.split(/\s+/).filter(Boolean).length;

  if (p.mode === 'ANALYTIC') {
    if (words > 40) flags.push(`analytic_turn_over_40_words:${words}`);

    const challengeCount =
      ctx.recentActs.slice(0, 4).filter((a) => CHALLENGE_ACTS.has(a)).length +
      (isChallengeAct(p.act) ? 1 : 0);
    if (challengeCount > 2) flags.push(`challenge_cap_exceeded:${challengeCount}_in_5`);

    const lastTwo = ctx.recentActs.slice(0, 2);
    if (p.act === 'A1' && lastTwo.length === 2 && lastTwo.every((a) => a === 'A1'))
      flags.push('three_consecutive_A1');

    const lastTwoA2 = ctx.recentActs.slice(0, 2);
    if (p.act === 'A2' && lastTwoA2.length === 2 && lastTwoA2.every((a) => a === 'A2'))
      flags.push('three_consecutive_A2');

    if (p.act === 'A7' && ctx.recentActs.includes('A7')) flags.push('second_cut_in_session');
    if (p.act === 'A7' && ctx.turnCount < 8) flags.push('cut_before_turn_8');

    if (/\b(exactly|right|i see what you mean|that makes sense|absolutely)\b/i.test(p.say))
      flags.push('mirror_check_comprehension_display');

    const assentCount = ctx.assentCountLast5 ?? 0;
    if (assentCount >= 3) flags.push(`assent_instead_of_association:${assentCount}_of_5`);

    if (!isRequiredSpeechTurn(p)) {
      if (/\b(many people|most people|it'?s normal|that'?s common)\b/i.test(p.say))
        flags.push('normalisation');

      if (/\b(you should|have you tried|i'?d suggest|why don'?t you)\b/i.test(p.say))
        flags.push('advice');

      if (/\bi (feel|understand|hear you|care|am here)\b/i.test(p.say))
        flags.push('claimed_feeling_or_presence');
    }
  }

  if (p.mode === 'ANCHORED' && p.act && ['A5', 'A7', 'A9', 'A14', 'A15', 'A16', 'A17', 'A19'].includes(p.act))
    flags.push(`forbidden_act_in_anchored:${p.act}`);

  // Hotline invention: any phone-shaped number that is not in the configured list.
  const numbers = p.say.match(/\b\d{3,4}[- ]?\d{3,4}[- ]?\d{0,4}\b/g) ?? [];
  for (const n of numbers) {
    if (config.crisisResources === 'UNAVAILABLE' || !config.crisisResources.includes(n.trim()))
      flags.push(`possible_invented_number:${n.trim()}`);
  }

  return flags;
}
