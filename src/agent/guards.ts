import { config } from '../config.js';
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

const REQUIRED_SPEECH_ACTS = new Set(['A13', 'A20']);

/** A13, A20 and §4.6a corrections are required speech; the required-speech-shaped checks don't apply to them. */
function isRequiredSpeechTurn(p: ParsedTurn): boolean {
  return (p.act !== null && REQUIRED_SPEECH_ACTS.has(p.act)) || /4\.6a/.test(p.work);
}

export interface AuditContext {
  recentActs: string[];
  mode: ParsedTurn['mode'];
  turnCount: number;
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

    const lastThree = ctx.recentActs.slice(0, 3);
    if (p.act === 'A1' && lastThree.length === 3 && lastThree.every((a) => a === 'A1'))
      flags.push('four_consecutive_A1');

    if (p.act === 'A2' && ctx.recentActs.slice(0, 2).every((a) => a === 'A2'))
      flags.push('three_consecutive_A2');

    if (p.act === 'A7' && ctx.recentActs.includes('A7')) flags.push('second_cut_in_session');
    if (p.act === 'A7' && ctx.turnCount < 8) flags.push('cut_before_turn_8');

    if (/\b(exactly|right|i see what you mean|that makes sense|absolutely)\b/i.test(p.say))
      flags.push('mirror_check_comprehension_display');

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
