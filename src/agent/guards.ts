import { config } from '../config.js';
import { parseTurn } from './parse.js';
import { STOP } from './ledger.js';
import type { EndDecision, ParsedTurn } from '../types.js';

/**
 * The closed set of canned minimal forms, in the order the prompt lists them.
 * "One of his own words" is not in this set — it is open-ended and cannot be
 * deterministically tracked or substituted without interpreting content.
 */
export const MINIMAL_FORMS = ['Go on.', 'Say more.', 'Hm.'];

function normalizeForComparison(text: string): string {
  return text.trim().replace(/[.!?,;:׃…]+$/g, '').trim().toLowerCase();
}

const NORMALIZED_MINIMAL_FORMS = MINIMAL_FORMS.map(normalizeForComparison);

/** The canonical form `say` matches, if any — null means it's his own word, not tracked. */
export function matchMinimalForm(say: string): string | null {
  const idx = NORMALIZED_MINIMAL_FORMS.indexOf(normalizeForComparison(say));
  return idx === -1 ? null : MINIMAL_FORMS[idx];
}

/** First canonical form not in `used`, in repertoire order — null once exhausted. */
export function nextUnusedMinimalForm(used: string[]): string | null {
  return MINIMAL_FORMS.find((f) => !used.includes(f)) ?? null;
}

/**
 * Adversarial round 3, finding 1: the "Go on." placeholder for an empty or
 * refused draft was applied unconditionally, mode included — a provider
 * refusal or a malformed GATE turn with no <say> content would show the
 * analytic-mode placeholder in place of a crisis response. GATE gets its own
 * safe, plain fallback instead; every other mode is unaffected.
 */
export function emptySayFallback(mode: ParsedTurn['mode'], crisisResources: string): string {
  if (mode !== 'GATE') return 'Go on.';
  const resourceLine =
    crisisResources === 'UNAVAILABLE'
      ? 'I do not have a verified number for your location — please look up your local emergency number or crisis line.'
      : crisisResources;
  return (
    'I do not have a reply from you to work with right now, and I am not going to leave that unaddressed. ' +
    'I am a machine, not a substitute for a person. If you are in danger, please contact emergency services now. ' +
    resourceLine
  );
}

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

/**
 * Adversarial round 3, finding 5: A16's own exclusion-1 and "Read twice"
 * name this as the most dangerous single instruction in the prompt — a turn
 * consisting only of a word naming self-annihilation, self-punishment,
 * restriction or harm is §8 material, not a signifier to let stand. The A16
 * cap/window/echo mechanisms are purely mechanical and never checked
 * content; this does. Deliberately the same words the prompt itself names,
 * in both languages this system reads — not an attempt at exhaustive
 * clinical coverage.
 */
const A16_DANGEROUS_WORDS = new Set([
  'disappear',
  'empty',
  'punish',
  'gone',
  'nothing',
  'להיעלם',
  'נעלם',
  'נעלמת',
  'תיעלם',
  'ריק',
  'ריקה',
  'להתרוקן',
  'התרוקן',
  'להעניש',
  'עונש',
  'איננו',
  'כלום',
]);

/** The dangerous word `say` names, if any — checked as tokens so a gloss ("I should just disappear") is caught, not only a bare echo. */
function findA16DangerousWord(say: string): string | null {
  for (const t of tokenize(say)) {
    if (A16_DANGEROUS_WORDS.has(t)) return t;
  }
  return null;
}

/**
 * Adversarial round 3, finding 2: §1's "never claim or imply feeling,
 * caring, being moved... absolutely and without exception, in every mode
 * including GATE" was enforced only by a non-blocking, English-only audit
 * regex. This is the same check, promoted, plus Hebrew, plus tolerance for
 * a simple intensifier ("I really care about you") the original missed.
 */
const CLAIMED_FEELING_EN =
  /\bi (?:really |truly |deeply |genuinely |always )?(?:feel|understand|hear you|care|am here)\b/i;
const CLAIMED_FEELING_HE = [
  'אני מרגיש',
  'אני מרגישה',
  'אני מבין',
  'אני מבינה',
  'אני שומע אותך',
  'אני שומעת אותך',
  'אני דואג',
  'אני דואגת',
  'אני כאן בשבילך',
  'אני איתך',
];

/**
 * Regression fix (live-transcript finding 1): quoting the analysand's own
 * words verbatim is the agent's single most characteristic act (Rule 1) —
 * an echo like '"אני מרגיש."' or '"2019."' is not the agent claiming
 * feeling or inventing a number, it is returning exactly what he said.
 * Strip every quoted span before running claimed-feeling/invented-number
 * detection, so only the agent's own unquoted voice is checked. Straight
 * double quotes, curly quotes, and Hebrew gershayim are stripped
 * unconditionally; straight single quotes only when neither apostrophe
 * sits between two letters, so contractions ("don't", "I'm") are not
 * mistaken for quote boundaries. This is a heuristic, not a parser, and can
 * still mishandle a quoted word that itself contains an apostrophe
 * ("'don't'").
 */
function stripQuotedSpans(text: string): string {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/״[^״]*״/g, ' ')
    .replace(/(?<![A-Za-zא-ת])'[^']*'(?![A-Za-zא-ת])/g, ' ')
    .replace(/(?<![A-Za-zא-ת])‘[^’]*’(?![A-Za-zא-ת])/g, ' ');
}

function findClaimedFeeling(say: string): string | null {
  const unquoted = stripQuotedSpans(say);
  const m = unquoted.match(CLAIMED_FEELING_EN);
  if (m) return m[0];
  const lower = unquoted.toLowerCase();
  for (const phrase of CLAIMED_FEELING_HE) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Same finding: "never invent, guess, or recall a hotline number" (§8) was
 * also audit-only, now promoted.
 *
 * Regression fix (live-transcript finding 2): the original digit-shaped
 * sequence check over-fired on ordinary numbers in the agent's own speech —
 * years, ages, counts — that are not phone numbers. Narrowed to: 3+ digits
 * AND (a separator between digit groups, OR immediate proximity to a
 * call/dial/text/hotline/number word). A quoted echo of a number is also
 * exempt, per finding 1 above. Known limitation, unchanged: short 2-3 digit
 * codes ("911", "988", "999") still don't match unless adjacent to a
 * trigger word — not something this narrowing introduces or widens.
 */
const SEPARATED_NUMBER_RE = /\b\d{2,4}(?:[-.\s]\d{2,4}){1,3}\b/g;
const BARE_NUMBER_RE = /\b\d{3,}\b/g;
const CALL_WORD_EN = /\b(?:call|dial|text|hotline|number)\b/i;
const CALL_WORD_HE = ['להתקשר', 'לחייג', 'מוקד', 'קו'];

function nearCallWord(say: string, index: number, length: number): boolean {
  const window = say.slice(Math.max(0, index - 30), Math.min(say.length, index + length + 30));
  if (CALL_WORD_EN.test(window)) return true;
  const lower = window.toLowerCase();
  return CALL_WORD_HE.some((w) => lower.includes(w));
}

function candidateNumbers(say: string): string[] {
  const candidates = new Set<string>();
  for (const m of say.matchAll(SEPARATED_NUMBER_RE)) candidates.add(m[0].trim());
  for (const m of say.matchAll(BARE_NUMBER_RE)) {
    if (nearCallWord(say, m.index ?? 0, m[0].length)) candidates.add(m[0].trim());
  }
  return [...candidates];
}

function findInventedNumber(say: string, crisisResources: string): string | null {
  const unquoted = stripQuotedSpans(say);
  for (const n of candidateNumbers(unquoted)) {
    if (crisisResources === 'UNAVAILABLE' || !crisisResources.includes(n)) return n;
  }
  return null;
}

export type DraftRetryReason =
  | { kind: 'possible_missed_gate' }
  | { kind: 'claimed_feeling'; phrase: string }
  | { kind: 'invented_number'; number: string }
  | { kind: 'reports_repetition' }
  | { kind: 'frame_complaint' }
  | { kind: 'run_limit'; act: string }
  | { kind: 'minimal_form_reused'; form: string }
  | { kind: 'a16_dangerous_word'; word: string }
  | { kind: 'a16_cap'; limit: number }
  | { kind: 'a16_window' }
  | { kind: 'a14_excluded' }
  | { kind: 'a15_excluded' }
  | { kind: 'echoed_signifier'; term: string }
  | { kind: 'near_duplicate'; overlap: number }
  | { kind: 'completing_interrupted_sentence' }
  | { kind: 'a16_self_marked_signifier' }
  | { kind: 'a15_unshakeable_certainty' };

/**
 * Conduct item 1: acts structurally incapable of supplying the missing word
 * — A3 quotes only what was actually said, A10 names the gap rather than
 * filling it. Required speech (A13, A20, §4.6a) is exempt separately, since
 * it states a plain fact rather than completing anything.
 */
const IMPLIED_WORD_SAFE_ACTS = new Set(['A3', 'A10']);

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
  /** Canonical minimal forms already used this session (see MINIMAL_FORMS). */
  usedMinimalForms: string[];
  /** Does the analysand's current turn complain about the frame or the relation (§5A.1)? */
  userFrameComplaint: boolean;
  /** Does the analysand's current turn report that he is repeating himself? */
  userReportsRepetition: boolean;
  /** Does the analysand's current turn match one of A14's six textually-identifiable exclusions? */
  userA14Excluded: boolean;
  /** Does the analysand's current turn match one of A15's textually-identifiable exclusions? */
  userA15Excluded: boolean;
  /** Does the analysand's current turn contain language §8 already names verbatim (see ledger.isExplicitCrisisLanguage)? */
  userExplicitCrisisLanguage: boolean;
  /** Conduct item 1: does the analysand's current turn end on an implied word (see ledger.endsOnImpliedWord)? */
  userEndsOnImpliedWord: boolean;
  /** Conduct item 2: has the analysand marked a signifier as specially his own and charged this turn? */
  userMarkedSignifierAsOwn: boolean;
  /** Conduct item 3: does the analysand's current turn carry unshakeable, world-organising certainty? */
  userUnshakeableCertainty: boolean;
}

/**
 * Everything that earns a draft exactly one regeneration.
 *
 * Two tiers. The first — possible_missed_gate, claimed_feeling,
 * invented_number — are never excluded: §8 outranks everything per the
 * prompt's own precedence, and §1's honesty rules apply "absolutely and
 * without exception, in every mode including GATE." These run even in GATE,
 * ANCHORED, and required speech.
 *
 * The rest — a hard block on a minimal act when the analysand reports
 * repetition or complains about the frame, a third consecutive identical
 * act, a reused minimal form, A16 on a self-annihilation word, the A16
 * session cap or two-turn window, A14/A15 used against a
 * textually-identifiable exclusion, any-form return of a currently-blocked
 * signifier, or a near-duplicate of a recent utterance — are excluded in
 * GATE, ANCHORED and required speech: those are about regenerating for
 * stylistic or contextual reasons, which safety and required speech never
 * are.
 */
export function decideDraftRetry(p: ParsedTurn, ctx: DraftRetryContext): DraftRetryReason | null {
  if (ctx.userExplicitCrisisLanguage && p.mode !== 'GATE') return { kind: 'possible_missed_gate' };

  const claimedFeeling = findClaimedFeeling(p.say);
  if (claimedFeeling) return { kind: 'claimed_feeling', phrase: claimedFeeling };

  const inventedNumber = findInventedNumber(p.say, config.crisisResources);
  if (inventedNumber) return { kind: 'invented_number', number: inventedNumber };

  // Conduct item 1 (Seminar III p.210): applies in ANALYTIC and ANCHORED —
  // not GATE, which uses act: GATE rather than the numbered repertoire, and
  // not required speech, which states a plain fact rather than completing
  // anything. Checked only against a genuine numbered act: plain ANCHORED
  // prose with no specific act cited isn't policed for content-level
  // completion here — that would need a grammar check, deliberately not
  // attempted (fragile, and this system's established pattern is to
  // restrict the move rather than police the prose after the fact).
  if (
    ctx.userEndsOnImpliedWord &&
    p.mode !== 'GATE' &&
    !isRequiredSpeechTurn(p) &&
    p.act !== null &&
    /^A\d+$/.test(p.act) &&
    !IMPLIED_WORD_SAFE_ACTS.has(p.act)
  ) {
    return { kind: 'completing_interrupted_sentence' };
  }

  if (p.mode === 'GATE' || p.mode === 'ANCHORED') return null;
  if (isRequiredSpeechTurn(p)) return null;
  if (p.act === null) return null;

  if (p.act === 'A1' && ctx.userReportsRepetition) return { kind: 'reports_repetition' };
  if (p.act === 'A1' && ctx.userFrameComplaint) return { kind: 'frame_complaint' };

  if (wouldBeThirdConsecutive(p.act, ctx.recentActs)) return { kind: 'run_limit', act: p.act };

  if (p.act === 'A1') {
    const form = matchMinimalForm(p.say);
    if (form && ctx.usedMinimalForms.includes(form)) return { kind: 'minimal_form_reused', form };
  }

  if (p.act === 'A14' && ctx.userA14Excluded) return { kind: 'a14_excluded' };
  if (p.act === 'A15' && ctx.userA15Excluded) return { kind: 'a15_excluded' };
  // Conduct item 3 (Seminar III p.157): additive to the existing exclusion above.
  if (p.act === 'A15' && ctx.userUnshakeableCertainty) return { kind: 'a15_unshakeable_certainty' };

  if (p.act === 'A16') {
    const dangerousWord = findA16DangerousWord(p.say);
    if (dangerousWord) return { kind: 'a16_dangerous_word', word: dangerousWord };
    // Conduct item 2 (Seminar III p.54-55).
    if (ctx.userMarkedSignifierAsOwn) return { kind: 'a16_self_marked_signifier' };
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
  /** True when the retry still violated some rule (possibly a different one), OR the retry call itself failed. */
  retryFailed: boolean;
  /** The reason that triggered the retry, or — on failure — whichever reason still applies. */
  reason: DraftRetryReason | null;
  /**
   * Set only when the server itself swapped a reused minimal form for an
   * unused one from MINIMAL_FORMS — that substitution requires no
   * interpretation, so it isn't a "failure" the way other pass-throughs are.
   */
  substituted: { from: string; to: string } | null;
  /**
   * Adversarial round 3, finding 3: true when the *retry call itself*
   * threw (network/provider error), as distinct from the retry succeeding
   * but still violating the rule. In this case `parsed` is never the
   * original flagged draft — falling back to it would silently serve
   * exactly the content the rule exists to prevent, so a safe placeholder
   * (guards.emptySayFallback) is substituted instead.
   */
  retryErrored: boolean;
}

/**
 * Discards a draft that trips `decideDraftRetry` and asks the provider for
 * exactly one alternative, naming the specific reason as forbidden.
 *
 * If the retry still repeats an already-used minimal form, the server
 * substitutes the next unused one from MINIMAL_FORMS deterministically —
 * minimal acts are contentless punctuation, so swapping within that closed
 * set does not interpret anything. Any other continued violation (including
 * a minimal act still forbidden by a hard block) is accepted as-is: the user
 * is never blocked and never sees an error, and the failure is reported via
 * `retryFailed` for the caller to log. Substantive speech is never rewritten
 * by the server.
 *
 * If the retry call itself fails (not a violation — a genuine network or
 * provider error), the original flagged draft is never returned: a safe
 * fallback is substituted instead, and `retryErrored` is set so the caller
 * can log it distinctly from an ordinary retry failure.
 */
export async function withDraftRetry(
  parsed: ParsedTurn,
  raw: string,
  ctx: DraftRetryContext,
  retry: (reason: DraftRetryReason) => Promise<string>,
): Promise<DraftRetryResult> {
  const reason = decideDraftRetry(parsed, ctx);
  if (!reason) {
    return { parsed, raw, retried: false, retryFailed: false, reason: null, substituted: null, retryErrored: false };
  }

  let retryRaw: string;
  try {
    retryRaw = await retry(reason);
  } catch {
    const safeParsed: ParsedTurn = { ...parsed, say: emptySayFallback(parsed.mode, config.crisisResources) };
    return { parsed: safeParsed, raw, retried: true, retryFailed: true, reason, substituted: null, retryErrored: true };
  }

  let retryParsed = parseTurn(retryRaw);
  const stillViolates = decideDraftRetry(retryParsed, ctx);

  if (stillViolates?.kind === 'minimal_form_reused') {
    const next = nextUnusedMinimalForm(ctx.usedMinimalForms);
    if (next) {
      const substituted = { from: stillViolates.form, to: next };
      retryParsed = { ...retryParsed, say: next };
      return {
        parsed: retryParsed,
        raw: retryRaw,
        retried: true,
        retryFailed: false,
        reason: stillViolates,
        substituted,
        retryErrored: false,
      };
    }
  }

  return {
    parsed: retryParsed,
    raw: retryRaw,
    retried: true,
    retryFailed: stillViolates !== null,
    reason: stillViolates ?? reason,
    substituted: null,
    retryErrored: false,
  };
}

export function retryOverrideMessage(reason: DraftRetryReason): string {
  switch (reason.kind) {
    case 'possible_missed_gate':
      return `\n\nSERVER OVERRIDE: what he said matches language §8 names directly (worthlessness, burdensomeness, or explicit self-harm/suicide language), and this turn is not GATE. Re-read §8 now. If this is gate material, switch to GATE and answer directly, at whatever length is needed. If you are genuinely confident it is not — he is quoting someone else, or the words plainly are not about himself — say so, but check twice: when in doubt about risk, you are not in doubt.`;
    case 'claimed_feeling':
      return `\n\nSERVER OVERRIDE: this draft claims feeling, caring, understanding, hearing, or presence ("${reason.phrase}") — §1 forbids this absolutely, in every mode including GATE. Remove the claim; keep everything else, including any safety-relevant content, intact.`;
    case 'invented_number':
      return `\n\nSERVER OVERRIDE: "${reason.number}" is not on the verified crisis-resources list and must never be invented, guessed, or recalled. If no verified number is available, say so plainly and direct him to look up his local emergency number or crisis line instead.`;
    case 'reports_repetition':
      return `\n\nSERVER OVERRIDE: the analysand is reporting that you did not hear him — he is repeating himself. A minimal act is forbidden this turn. Return what he actually said.`;
    case 'frame_complaint':
      return `\n\nSERVER OVERRIDE: the analysand is complaining about the frame or the relation, not his material. This is required speech (§5A.1) — punctuate the transference (A8) or state the lack (A20). A minimal act is forbidden this turn.`;
    case 'run_limit':
      return `\n\nSERVER OVERRIDE: ${reason.act} would be the third consecutive identical act this turn. ${reason.act} is forbidden — choose a different act, or A20.`;
    case 'minimal_form_reused':
      return `\n\nSERVER OVERRIDE: "${reason.form}" has already been used as a minimal act this session. Do not reuse it — choose a different minimal form, one of his own words, or a different act.`;
    case 'a16_dangerous_word':
      return `\n\nSERVER OVERRIDE: "${reason.word}" names self-annihilation, self-punishment, restriction or harm. Per §8 this is gate material, not a signifier to let stand — A16 is forbidden this turn. Reconsider whether this turn requires the gate.`;
    case 'a14_excluded':
      return `\n\nSERVER OVERRIDE: what he said matches one of A14's six exclusions (abstinence/recovery commitment, treatment adherence, protective boundary, material/bodily/developmental constraint, first disclosure, or worthlessness/burdensomeness). A14 is forbidden this turn — choose a different act.`;
    case 'a15_excluded':
      return `\n\nSERVER OVERRIDE: what he said matches one of A15's exclusions (a clinical diagnosis, a disability or neurodevelopmental term, vocabulary shared with active treatment, a frame that replaced self-blame, or an ordinary emotion word). A15 is forbidden this turn — choose a different act.`;
    case 'a16_cap':
      return `\n\nSERVER OVERRIDE: A16 has already been used ${reason.limit} times this session, the session cap. A16 is forbidden this turn — choose a different act.`;
    case 'a16_window':
      return `\n\nSERVER OVERRIDE: A16 was used within the last two turns. A16 is forbidden this turn — choose a different act.`;
    case 'echoed_signifier':
      return `\n\nSERVER OVERRIDE: "${reason.term}" has already been returned via A16 this session and is still off-limits. Do not return it again in any form — bare, glossed, translated, or quoted. Choose a different act, or a different word.`;
    case 'near_duplicate':
      return `\n\nSERVER OVERRIDE: this draft repeats one of your last three turns in different words (overlap ${reason.overlap.toFixed(2)}). Say something materially different, or use a minimal act instead.`;
    case 'completing_interrupted_sentence':
      return `\n\nSERVER OVERRIDE: he stopped mid-sentence and the missing word is implied, not absent. Do not supply it, gloss it, or finish the sentence for him. Use A10 (name the gap, flat) or A3 (quote only what he actually said) instead.`;
    case 'a16_self_marked_signifier':
      return `\n\nSERVER OVERRIDE: he has marked a signifier as specially his own and charged this turn. A16 is forbidden — echoing it back adds the weight of the Other to something that is already fully his. Choose a different act.`;
    case 'a15_unshakeable_certainty':
      return `\n\nSERVER OVERRIDE: what he said carries unshakeable certainty and organises how he understands his own reality — it is not borrowed vocabulary, even if it sounds like it. A15 is forbidden this turn — choose a different act.`;
  }
}

export function retryFailureFlag(reason: DraftRetryReason): string {
  switch (reason.kind) {
    case 'possible_missed_gate':
      return 'possible_missed_gate_retry_failed';
    case 'claimed_feeling':
      return `claimed_feeling_retry_failed:${reason.phrase}`;
    case 'invented_number':
      return `invented_number_retry_failed:${reason.number}`;
    case 'reports_repetition':
      return 'reports_repetition_retry_failed';
    case 'frame_complaint':
      return 'frame_complaint_retry_failed';
    case 'run_limit':
      return `run_limit_retry_failed:${reason.act}`;
    case 'minimal_form_reused':
      return `minimal_form_reused_retry_failed:${reason.form}`;
    case 'a16_dangerous_word':
      return `a16_dangerous_word_retry_failed:${reason.word}`;
    case 'a14_excluded':
      return 'a14_excluded_retry_failed';
    case 'a15_excluded':
      return 'a15_excluded_retry_failed';
    case 'a16_cap':
      return 'a16_cap_retry_failed';
    case 'a16_window':
      return 'a16_window_retry_failed';
    case 'echoed_signifier':
      return `echoed_signifier_retry_failed:${reason.term}`;
    case 'near_duplicate':
      return `near_duplicate_retry_failed:${reason.overlap.toFixed(2)}`;
    case 'completing_interrupted_sentence':
      return 'completing_interrupted_sentence_retry_failed';
    case 'a16_self_marked_signifier':
      return 'a16_self_marked_signifier_retry_failed';
    case 'a15_unshakeable_certainty':
      return 'a15_unshakeable_certainty_retry_failed';
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

  // Conduct item 6: A1 added, per adversarial round 2 — it returns "one of
  // his own words... without comment," which is exactly the mechanism
  // Seminar III p.209's warning describes (an interlocutor who mostly
  // returns a person's own words, producing only frustration, not relation).
  if (p.mode === 'ANCHORED' && p.act && ['A1', 'A5', 'A7', 'A9', 'A14', 'A15', 'A16', 'A17', 'A19'].includes(p.act))
    flags.push(`forbidden_act_in_anchored:${p.act}`);

  // Hotline invention: any phone-shaped number that is not in the configured list.
  const numbers = p.say.match(/\b\d{3,4}[- ]?\d{3,4}[- ]?\d{0,4}\b/g) ?? [];
  for (const n of numbers) {
    if (config.crisisResources === 'UNAVAILABLE' || !config.crisisResources.includes(n.trim()))
      flags.push(`possible_invented_number:${n.trim()}`);
  }

  return flags;
}
