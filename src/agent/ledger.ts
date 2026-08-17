import type {
  BorrowedTermNomination,
  EchoedSignifier,
  Formation,
  FormationNomination,
  Ledger,
  ParsedTurn,
  SemanticFieldNomination,
} from '../types.js';

/**
 * Deterministic listening support. This does not replace the model's reading —
 * it keeps a stable count across sessions so that "that word again" is a fact
 * and not an impression, and it flags the categories the spec says must never
 * be silently substituted.
 */

/**
 * Function words filtered from signifier tracking. Hebrew forms cover the
 * same closed categories as the English list (pronouns, demonstratives,
 * copula/existential, modal auxiliaries, prepositions, conjunctions,
 * question words, quantifiers), including the most common PREFIXED forms
 * (ו/ה/ב/ל/כ/מ/ש fused onto a following function word, e.g. "שזה", "ואני") —
 * see normalizeHebrewPrefix below for the general single-prefix stripping
 * rule applied to content words at extraction time.
 */
export const STOP = new Set([
  ...`a an the and or but if then than that this these those i me my mine you your yours he him his she her
   it its we us our they them their am is are was were be been being do does did done have has had will
   would can could should shall may might must of in on at to for with from by about as so just really
   very not no yes what when where who whom how why there here get got go going went know think feel
   like said say says because into out up down over under again more most some any all one two`.split(/\s+/),
  ...`אני אתה את הוא היא אנחנו אתם אתן הם הן אותי אותך אותו אותה אותנו אתכם אתכן אותם אותן לי לך לו לה לנו
   לכם לכן להם להן זה זאת זו אלה אלו היה היתה היו להיות יש אין יכול יכולה יכולים יכולות צריך צריכה צריכים
   צריכות עם אל על אצל בלי עד אחרי לפני מול ליד תחת מעל בין נגד כמו כי אם אבל או גם רק אז לא כן מה מי איפה
   למה איך מתי כמה איזה איזו כל עוד כבר תמיד עדיין פעם הרבה מעט משהו מישהו כלום כאן שם עכשיו היום אתמול
   מחר אחד אחת שני שתי`.split(/\s+/),
  ...`ואני ועכשיו שאני שאולי שהוא שהיא שזה ומה ומתי ואיך האלו האלה הזה הזאת ממה לעומת במהלך לשאר אליהם
   אליה אליו שלי שלנו שלה שלו לפני אחרי בגלל למרות אולי בערך ממש בכלל כאילו`.split(/\s+/),
]);

/**
 * Hebrew attaches ה/ו/ב/ל/כ/מ/ש directly to the next word with no space
 * (e.g. "ומותר", "בבית"). Fused stopword forms are handled by the STOP list
 * above; this strips ONE such prefix from a CONTENT word so e.g. "יחסים" and
 * "ביחסים" are counted as the same signifier. Unconditional except for a
 * length floor and a check that the remainder isn't itself a function word.
 *
 * מ is deliberately EXCLUDED from the strippable set, unlike the other six
 * letters. Verified against real examples: stripping מ unconditionally turns
 * "מותר" into "ותר" (not a word) and "משווה" into "שווה" (a real but wrong
 * word, "worth" vs. "comparing") — because מ is not only the "from"
 * preposition but also the Hebrew present-tense/participle marker (מודד,
 * משווה), making it far more often the genuine first letter of a content
 * word than the other six. Excluding it still correctly unifies "ומודד"
 * with "מודד" and "ומשווה" with "משווה" (only the leading ו is stripped),
 * without corrupting the bare forms. This is a deviation from a literal
 * "strip any of ה/ו/ב/ל/כ/מ/ש" reading — flagged because it changes the
 * rule as specified, not merely an implementation detail.
 *
 * Known remaining limitation: stripping only ONE prefix does not unify
 * doubly-prefixed forms (e.g. "וליחסים", ו+ל+יחסים) with the bare form —
 * they normalize one prefix layer down ("ליחסים") and stay a separate entry.
 */
const HEBREW_PREFIXES = new Set(['ה', 'ו', 'ב', 'ל', 'כ', 'ש']);

export function normalizeHebrewPrefix(word: string): string {
  const first = word[0];
  if (!first || !HEBREW_PREFIXES.has(first)) return word;
  const remainder = word.slice(1);
  if (remainder.length < 3 || STOP.has(remainder)) return word;
  return remainder;
}

// Note: \b is defined over ASCII \w and does not fire correctly at the edges
// of Hebrew script, so the _HE pattern lists below never use it.

const LAW_PATTERNS_EN = [
  /\bi'?m (?:just )?(?:someone|somebody|a person) who\b/i,
  /\bthat'?s (?:just )?(?:how it is|the reality|life)\b/i,
  /\bi (?:can'?t|cannot) [a-z]/i,
  /\bi'?ll never\b/i,
  /\bi always\b/i,
];

const LAW_PATTERNS_HE = [
  /אני (?:פשוט |סתם )?מישהו ש/,
  /ככה זה/,
  /זאת המציאות/,
  /אני (?:אף פעם |מעולם )?לא (?:יכול|מסוגל|מצליח)/,
  /אני לעולם לא/,
  /אני תמיד/,
  /(?:לא )?מקובל/,
];

const LAW_PATTERNS = [...LAW_PATTERNS_EN, ...LAW_PATTERNS_HE];

const NEGATION_PATTERNS_EN = [
  /\b(?:he|she|they|we|you|it)\s+never\s+([a-z][^.!?]*)/i,
  /\bnobody\s+(?:ever\s+)?([a-z][^.!?]*)/i,
  /\bno\s+one\s+(?:ever\s+)?([a-z][^.!?]*)/i,
  /\bi\s+never\s+(?:got|had|received)\s+([a-z][^.!?]*)/i,
];

const NEGATION_PATTERNS_HE = [
  /(?:הוא|היא|הם|הן|את|אתה)\s+(?:אף פעם|מעולם)\s+לא\s+([א-ת][^.!?]*)/,
  /אף אחד\s+(?:אף פעם\s+)?לא\s+([א-ת][^.!?]*)/,
  /אני\s+(?:אף פעם|מעולם)\s+לא\s+(?:קיבלתי|היה לי)\s+([א-ת][^.!?]*)/,
];

const NEGATION_PATTERNS = [...NEGATION_PATTERNS_EN, ...NEGATION_PATTERNS_HE];

const SPONTANEOUS_NEGATION_EN = /\b(?:it'?s not that|i'?m not saying|not because|it wasn'?t that)\b/i;
const SPONTANEOUS_NEGATION_HE = /(?:זה לא ש|אני לא אומר ש|לא בגלל ש|זה לא היה ש)/;

function isSpontaneousNegation(s: string): boolean {
  return SPONTANEOUS_NEGATION_EN.test(s) || SPONTANEOUS_NEGATION_HE.test(s);
}

const TRANSFERENCE_EN = [
  /\byou'?re the only\b/i,
  /\bthe only one who\b/i,
  /\byou (?:really )?(?:get|understand) me\b/i,
  /\bi (?:can )?only talk to you\b/i,
  /\bi'?ve been waiting (?:all day )?(?:for|to talk)\b/i,
];

const TRANSFERENCE_HE = [
  /את[ה]?\s+(?:היחיד|היחידה)\s+ש/,
  /רק את[ה]?\s+(?:מבין|מבינה)\s+אותי/,
  /את[ה]?\s+(?:באמת\s+)?(?:מבין|מבינה)\s+אותי/,
  /אני\s+יכול(?:ה)?\s+לדבר\s+רק\s+איתך/,
  /חיכיתי\s+כל\s+היום\s+לדבר/,
];

const TRANSFERENCE = [...TRANSFERENCE_EN, ...TRANSFERENCE_HE];

const DESUPPOSITION_EN = [
  /\byou'?re (?:just|only) (?:a|an) (?:machine|bot|program|ai|algorithm)\b/i,
  /\bthis is pointless\b/i,
  /\byou don'?t (?:actually |really )?know (?:anything|me)\b/i,
];

const DESUPPOSITION_HE = [
  /את[ה]?\s+(?:רק|סתם)\s+(?:מכונה|בוט|תוכנה|תוכנת מחשב|בינה מלאכותית|אלגוריתם)/,
  /זה\s+חסר\s+טעם/,
  /את[ה]?\s+לא\s+(?:באמת\s+)?יודע(?:ת)?\s+(?:כלום|אותי)/,
];

const DESUPPOSITION = [...DESUPPOSITION_EN, ...DESUPPOSITION_HE];

/** Technical vocabulary that is imported theory rather than ordinary feeling. */
const BORROWED = [
  'avoidant attachment', 'anxious attachment', 'attachment style', 'trauma response',
  'inner child', 'dysregulated', 'dysregulation', 'triggered', 'codependent', 'codependency',
  'narcissist', 'narcissistic', 'gaslighting', 'boundaries', 'nervous system', 'fight or flight',
  'executive dysfunction', 'masking', 'rejection sensitivity', 'people pleasing', 'self-sabotage',
  'shadow work', 'limerence', 'hypervigilant', 'hypervigilance', 'somatic', 'attachment wound',
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A stutter: the same token reappearing within a 3-token window (positions
 * i, i+1, i+2), including an immediate repeat. Mechanical and
 * language-agnostic — no interpretation, no stopword exclusion; the point is
 * the formal repetition, not which word it happens to be.
 */
function hasRepeatedToken(sentence: string): boolean {
  const tokens = wordsOf(sentence);
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < Math.min(i + 3, tokens.length); j++) {
      if (tokens[i] === tokens[j]) return true;
    }
  }
  return false;
}

export interface LedgerUpdate {
  ledger: Ledger;
  desupposition: boolean;
}

export function updateLedgerFromUser(
  ledger: Ledger,
  text: string,
  sessionIndex: number,
  turnIndex: number,
): LedgerUpdate {
  const l: Ledger = structuredClone(ledger);
  const sents = sentences(text);

  // --- signifiers ---
  // Dedupe and count under the prefix-stripped key (normalizeHebrewPrefix is
  // a no-op for non-Hebrew words), but keep the raw surface form for context
  // lookup and for echoing back what the analysand actually typed.
  const rawWords = wordsOf(text);
  const seenThisTurn = new Set<string>();
  for (const raw of rawWords) {
    if (STOP.has(raw)) continue;
    const key = normalizeHebrewPrefix(raw);
    if (STOP.has(key) || seenThisTurn.has(key)) continue;
    seenThisTurn.add(key);
    const ctx = sents.find((s) => s.toLowerCase().includes(raw)) ?? text.slice(0, 160);
    const existing = l.signifiers.find((s) => s.term === key);
    if (existing) {
      existing.count += 1;
      if (!existing.turns_seen.includes(turnIndex)) existing.turns_seen.push(turnIndex);
      existing.turns_seen = existing.turns_seen.slice(-20);
      if (!existing.surface_forms.includes(raw)) existing.surface_forms.push(raw);
      existing.surface_forms = existing.surface_forms.slice(-10);
      if (!existing.verbatim_contexts.includes(ctx)) existing.verbatim_contexts.push(ctx);
      if (existing.verbatim_contexts.length > 6) existing.verbatim_contexts.shift();
      // Function words are already excluded upstream (STOP, checked above on
      // both the raw and the stripped form); count and spread are the
      // remaining, explicit conditions — not left implicit in "count" alone.
      if (existing.count >= 3 && existing.turns_seen.length >= 2) existing.candidate_S1 = true;
    } else {
      l.signifiers.push({
        term: key,
        verbatim_contexts: [ctx],
        count: 1,
        first_seen_session: sessionIndex,
        candidate_S1: false,
        interpreted: false,
        turns_seen: [turnIndex],
        surface_forms: [raw],
      });
    }
  }

  // --- laws stated ---
  for (const s of sents) {
    if (LAW_PATTERNS.some((p) => p.test(s))) {
      l.laws_stated.push({ text: s, session: sessionIndex, turn: turnIndex, exclusion_class: null });
    }
  }

  // --- specific negations: keep the exact shape, never an equivalent ---
  for (const s of sents) {
    for (const p of NEGATION_PATTERNS) {
      const m = s.match(p);
      if (m) {
        const already = l.specific_negations.some((n) => n.verbatim === s);
        if (!already) {
          l.specific_negations.push({
            verbatim: s,
            negated_object: m[1]?.trim() ?? s,
            not: '',
            substituted_by_agent: false,
          });
        }
        break;
      }
    }
    if (isSpontaneousNegation(s)) {
      l.formations.push({
        type: 'spontaneous_negation',
        session: sessionIndex,
        turn: turnIndex,
        text: s,
      });
    }
  }

  // --- slips and self-corrections ---
  for (const s of sents) {
    const m = s.match(/\b([a-z]+)\s*[—–-]{1,2}\s*(?:i mean,?\s*)?([a-z]+)\b/i);
    if (m && m[1].toLowerCase() !== m[2].toLowerCase()) {
      l.formations.push({ type: 'slip', session: sessionIndex, turn: turnIndex, text: s });
    }
  }

  // --- stutter / immediate repetition: mechanical, not interpreted ---
  // Same token reappearing within a 3-token window (including an immediate
  // repeat) is recorded verbatim as a self-correction-type formation.
  for (const s of sents) {
    if (hasRepeatedToken(s)) {
      l.formations.push({ type: 'self_correct', session: sessionIndex, turn: turnIndex, text: s });
    }
  }

  // --- borrowed terms: load_bearing defaults to true, nothing is punctured unchecked ---
  const lower = text.toLowerCase();
  for (const term of BORROWED) {
    if (lower.includes(term) && !l.borrowed_terms.some((b) => b.term === term)) {
      l.borrowed_terms.push({
        term,
        source: 'unknown',
        load_bearing: true,
        puncture_permitted: false,
        suspected_register: '',
        nomination_count: 0,
      });
    }
  }

  // --- transference: a closing, not a deepening ---
  for (const s of sents) {
    if (TRANSFERENCE.some((p) => p.test(s))) {
      l.transference_markers.push({ session: sessionIndex, turn: turnIndex, text: s, addressed: false });
    }
  }

  const desupposition = DESUPPOSITION.some((p) => p.test(text));

  // Keep the ledger bounded by distinct-term count, not by pruning fresh
  // entries: a signifier with count === 1 must survive to be found again on
  // a later turn, or its count can never advance past 1 in the first place.
  l.signifiers = l.signifiers.slice(-400);
  l.formations = l.formations.slice(-60);
  l.laws_stated = l.laws_stated.slice(-40);
  l.specific_negations = l.specific_negations.slice(-40);
  l.transference_markers = l.transference_markers.slice(-40);

  return { ledger: l, desupposition };
}

/**
 * Semantic fields, borrowed registers, laws and formations the model reads
 * reliably in context but regex cannot find — nominated in the model's
 * <work> block (§11), additive to the deterministic layers above, and never
 * a route to master_signifiers, which stays governed by do_not_interpret and
 * risk_class alone.
 */
export function recordSemanticFieldNomination(
  ledger: Ledger,
  nomination: SemanticFieldNomination,
  sessionIndex: number,
  turnIndex: number,
): Ledger {
  if (!nomination.name) return ledger;
  const l: Ledger = structuredClone(ledger);
  const existing = l.semantic_fields.find(
    (f) => f.name.toLowerCase() === nomination.name.toLowerCase(),
  );
  if (existing) {
    existing.nomination_count += 1;
    existing.last_session = sessionIndex;
    existing.last_turn = turnIndex;
    for (const term of nomination.member_terms) {
      if (!existing.member_terms.includes(term)) existing.member_terms.push(term);
    }
  } else {
    l.semantic_fields.push({
      name: nomination.name,
      member_terms: [...nomination.member_terms],
      nomination_count: 1,
      first_seen_session: sessionIndex,
      last_session: sessionIndex,
      last_turn: turnIndex,
    });
  }
  l.semantic_fields = l.semantic_fields.slice(-100);
  return l;
}

export function recordBorrowedTermNomination(
  ledger: Ledger,
  nomination: BorrowedTermNomination,
): Ledger {
  if (!nomination.term) return ledger;
  const l: Ledger = structuredClone(ledger);
  const existing = l.borrowed_terms.find(
    (b) => b.term.toLowerCase() === nomination.term.toLowerCase(),
  );
  if (existing) {
    existing.nomination_count += 1;
    if (!existing.suspected_register && nomination.suspected_register) {
      existing.suspected_register = nomination.suspected_register;
    }
  } else {
    l.borrowed_terms.push({
      term: nomination.term,
      source: 'model_nomination',
      load_bearing: nomination.load_bearing,
      puncture_permitted: false,
      suspected_register: nomination.suspected_register,
      nomination_count: 1,
    });
  }
  return l;
}

export function recordLawStatedNomination(
  ledger: Ledger,
  verbatim: string,
  sessionIndex: number,
  turnIndex: number,
): Ledger {
  if (!verbatim) return ledger;
  const l: Ledger = structuredClone(ledger);
  l.laws_stated.push({ text: verbatim, session: sessionIndex, turn: turnIndex, exclusion_class: null });
  l.laws_stated = l.laws_stated.slice(-40);
  return l;
}

/** Free-text nominated `kind` mapped onto the closed Formation.type set; the original wording is kept in `note`. */
function mapFormationKind(kind: string): Formation['type'] {
  const k = kind.toLowerCase();
  if (k.includes('slip')) return 'slip';
  if (k.includes('correct') || k.includes('repeat') || k.includes('stutter')) return 'self_correct';
  if (k.includes('omit') || k.includes('omission')) return 'omission';
  if (k.includes('person')) return 'person_shift';
  if (k.includes('negat')) return 'spontaneous_negation';
  return 'self_correct';
}

export function recordFormationNomination(
  ledger: Ledger,
  nomination: FormationNomination,
  sessionIndex: number,
  turnIndex: number,
): Ledger {
  if (!nomination.kind || !nomination.verbatim) return ledger;
  const l: Ledger = structuredClone(ledger);
  l.formations.push({
    type: mapFormationKind(nomination.kind),
    session: sessionIndex,
    turn: turnIndex,
    text: nomination.verbatim,
    note: `model-nominated: ${nomination.kind}`,
  });
  l.formations = l.formations.slice(-60);
  return l;
}

/** Applies every nomination on a parsed turn to the ledger in one pass. */
export function recordNominations(
  ledger: Ledger,
  parsed: ParsedTurn,
  sessionIndex: number,
  turnIndex: number,
): Ledger {
  let l = ledger;
  for (const sf of parsed.semanticFieldNominations) {
    l = recordSemanticFieldNomination(l, sf, sessionIndex, turnIndex);
  }
  for (const bt of parsed.borrowedTermNominations) {
    l = recordBorrowedTermNomination(l, bt);
  }
  for (const law of parsed.lawStatedNominations) {
    l = recordLawStatedNomination(l, law, sessionIndex, turnIndex);
  }
  for (const f of parsed.formationNominations) {
    l = recordFormationNomination(l, f, sessionIndex, turnIndex);
  }
  return l;
}

export function recordAnalystNote(ledger: Ledger, note: string | null): Ledger {
  if (!note) return ledger;
  const l: Ledger = structuredClone(ledger);
  l.held_back.push({ observation: note.slice(0, 400), reason_held: 'model note' });
  l.held_back = l.held_back.slice(-20);
  return l;
}

/**
 * A16 returns a signifier alone and stops. Once a term has been returned this
 * way, returning it again in any form — bare, glossed, translated, or quoted
 * — trains a confirm-reflex, not something new. `normalizeEchoedSignifier`
 * extracts the bare term when the whole utterance IS the term (the
 * well-formed A16 case, used to detect a genuinely new signifier).
 */
export function normalizeEchoedSignifier(say: string): string {
  return say
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?,;:׃…]+$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Records a newly bare-echoed A16 term, and re-stamps the turn of any
 * already-known term that reappears in `say` in ANY form (bare, glossed,
 * translated as a quoted original, or otherwise) — the cooldown restarts
 * from the most recent occurrence, regardless of which act produced it.
 */
export function recordEchoedSignifier(
  ledger: Ledger,
  act: string | null,
  say: string,
  turn: number,
): Ledger {
  const lowerSay = say.toLowerCase();
  let touched = false;
  const echoed = ledger.echoed_signifiers.map((e) => {
    if (lowerSay.includes(e.term)) {
      touched = true;
      return { ...e, turn };
    }
    return e;
  });

  if (act === 'A16') {
    const term = normalizeEchoedSignifier(say);
    if (term && !echoed.some((e) => e.term === term)) {
      echoed.push({ term, turn });
      touched = true;
    }
  }

  if (!touched) return ledger;
  const l: Ledger = structuredClone(ledger);
  l.echoed_signifiers = echoed.slice(-100);
  return l;
}

/**
 * Terms still off-limits this turn: inside the 5-analyst-turn cooldown since
 * their most recent occurrence, or past it but never reintroduced by the
 * analysand himself since. `userTurns` need only cover turns after the
 * earliest echo turn present.
 */
export function blockedSignifiers(
  echoed: EchoedSignifier[],
  currentTurn: number,
  userTurns: { idx: number; text: string }[],
): string[] {
  return echoed
    .filter((e) => {
      const turnsSinceEcho = currentTurn - e.turn;
      if (turnsSinceEcho < 5) return true;
      const reintroduced = userTurns.some(
        (t) => t.idx > e.turn && t.text.toLowerCase().includes(e.term),
      );
      return !reintroduced;
    })
    .map((e) => e.term);
}

/**
 * Assent detection: a session can contract into a confirm-reflex without any
 * single guard firing, because the repeated act is not the analyst's — it is
 * the analysand's collapsing replies. Language-agnostic (Hebrew and English
 * both matter here); no stopword list exists for Hebrew, so every Hebrew word
 * counts as a content word.
 */
const ASSENT_TOKENS = ['לא נכון', 'כן', 'נכון', 'בדיוק', 'אכן', 'yes', 'right', 'correct', 'exactly', 'true'];

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}']{2,}/gu) ?? [];
}

function opensWithAssentToken(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ASSENT_TOKENS.some((tok) => {
    const tl = tok.toLowerCase();
    if (t === tl) return true;
    if (!t.startsWith(tl)) return false;
    const next = t[tl.length];
    return next === undefined || /[\s,.!?;:־׃]/.test(next);
  });
}

/**
 * A reply counts as assent if it opens with an assent token, or is four
 * words or fewer with no content word absent from what was already said.
 * An empty content-word set (a purely functional reply) vacuously satisfies
 * "no new content word" — that is the correct reading, not a bug: there is
 * no word to be new.
 */
export function isAssentReply(text: string, priorContentWords: Set<string>): boolean {
  if (opensWithAssentToken(text)) return true;
  const words = wordsOf(text);
  if (words.length > 4) return false;
  const contentWords = words.filter((w) => !STOP.has(w));
  return contentWords.every((w) => priorContentWords.has(w));
}

export interface AssentRunStats {
  /** Assent classification of the given texts, oldest to newest, last 5 only. */
  last5: boolean[];
  count: number;
}

/** `userTexts` is the full session's analysand turns, oldest first. */
export function assentRunStats(userTexts: string[]): AssentRunStats {
  const seen = new Set<string>();
  const flags: boolean[] = [];
  for (const text of userTexts) {
    flags.push(isAssentReply(text, seen));
    for (const w of wordsOf(text)) {
      if (!STOP.has(w)) seen.add(w);
    }
  }
  const last5 = flags.slice(-5);
  return { last5, count: last5.filter(Boolean).length };
}

/**
 * Complaint about the frame or the relation, not about his material — §5A.1.
 * Required speech; never answered with a minimal act. Checked against the
 * analysand's current turn only.
 */
const FRAME_COMPLAINT_EN = [
  /\bwhy do you keep saying that\b/i,
  /\bwhy do you keep (?:doing|repeating) that\b/i,
  /\bthis is frustrating\b/i,
  /\bthis (?:isn'?t|is not) helping\b/i,
  /\byou'?re not helping\b/i,
  /\byou (?:never|don'?t) answer\b/i,
  /\bwhat do you want from me\b/i,
  /\byou keep repeating (?:yourself|that)\b/i,
];

const FRAME_COMPLAINT_HE = [
  'אני אומר שוב',
  'אמרתי כבר',
  'לא הבנת',
  'אתה לא עונה',
  'זה מתסכל',
  'מתסכל אותי',
  'אני לא יודע איך להמשיך',
  'מה אתה רוצה ממני',
  'למה אתה חוזר',
  'אתה חוזר על עצמך',
  'זה לא עוזר',
];

export function isFrameComplaint(text: string): boolean {
  if (FRAME_COMPLAINT_EN.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  return FRAME_COMPLAINT_HE.some((phrase) => lower.includes(phrase));
}

/**
 * The analysand reporting that he is repeating himself — a report of a
 * failure of hearing, distinct from a general complaint about the frame
 * (§5A.1) even though the two categories share some trigger phrases.
 */
const REPETITION_EN = [
  /\bi already said\b/i,
  /\bas i said\b/i,
  /\bi'?m saying (?:this |that )?again\b/i,
  /\bi keep saying\b/i,
];

const REPETITION_HE = ['אני אומר שוב', 'אמרתי כבר', 'כמו שאמרתי', 'שוב אני אומר'];

export function reportsRepetition(text: string): boolean {
  if (REPETITION_EN.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  return REPETITION_HE.some((phrase) => lower.includes(phrase));
}

/**
 * Adversarial round 3, finding 6: A14/A15's six exclusions each (§6) were
 * enforced only as prompt text, with no server backup — the exact defect
 * class that produced two prior-round failures (A14 hystericising a
 * sobriety commitment).
 *
 * This is a best-effort textual backstop for the categories that are
 * actually identifiable from the analysand's own words, not a complete
 * implementation of all twelve exclusions — several depend on context this
 * function cannot see (whether a diagnosis came from a clinician he is
 * currently under, whether this is a *first* disclosure, whether a boundary
 * is protective against someone who harmed him). Those stay prompt-governed.
 * Covered here: A14's abstinence/recovery commitment, treatment/medication
 * adherence, material/bodily/developmental constraint, and worthlessness/
 * burdensomeness (also §8 material); A15's disability/neurodevelopmental
 * term naming.
 */
const A14_EXCLUDED_EN = [
  /\bi (?:can'?t|won'?t|don'?t|do not) (?:drink|use|gamble|smoke)\b/i,
  /\bnot (?:one|a drop|a single (?:drink|drop|pill))\b/i,
  /\b\w+ (?:days?|weeks?|months?|years?) sober\b/i,
  /\bin recovery\b/i,
  /\bstay(?:ing)? sober\b/i,
  /\bmy sobriety\b/i,
  /\bi (?:have to|need to|must) take (?:my|the) (?:medication|meds|pills?|lithium|insulin)\b/i,
  /\btake my (?:medication|meds|pills?|lithium|insulin) every\b/i,
  /\bnobody would miss me\b/i,
  /\bthey'?d be better off without me\b/i,
  /\bi'?m a burden\b/i,
  /\bi don'?t deserve to live\b/i,
];

const A14_EXCLUDED_HE = [
  'לא נוגע בטיפה',
  'לא שותה טיפה',
  'מפוכח',
  'מפוכחת',
  'נקי מסמים',
  'נקייה מסמים',
  'בהתפכחות',
  'חייב לקחת את התרופה',
  'חייבת לקחת את התרופה',
  'צריך לקחת תרופה',
  'צריכה לקחת תרופה',
  'אף אחד לא יתגעגע אליי',
  'יהיה להם יותר טוב בלעדיי',
  'אני נטל',
  'לא מגיע לי לחיות',
];

/** Shared between A14 exclusion (4) and A15 exclusion (2) — a material/bodily/neurodevelopmental term. */
const DISABILITY_TERMS_EN = [
  /\b(?:autis(?:m|tic)|disab(?:led|ility)|dialysis|wheelchair|chronic illness|neurodivergen(?:t|ce)|adhd|dyslexi[ac])\b/i,
];

const DISABILITY_TERMS_HE = [
  'אוטיזם',
  'אוטיסט',
  'אוטיסטית',
  'נכות',
  'מוגבלות',
  'דיאליזה',
  'כיסא גלגלים',
  'דיסלקציה',
];

export function isA14Excluded(text: string): boolean {
  if (A14_EXCLUDED_EN.some((p) => p.test(text))) return true;
  if (DISABILITY_TERMS_EN.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  if (A14_EXCLUDED_HE.some((phrase) => lower.includes(phrase))) return true;
  return DISABILITY_TERMS_HE.some((phrase) => lower.includes(phrase));
}

export function isA15Excluded(text: string): boolean {
  if (DISABILITY_TERMS_EN.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  return DISABILITY_TERMS_HE.some((phrase) => lower.includes(phrase));
}

/**
 * Adversarial round 3, finding 4: gate detection has NO independent
 * server-side check at all — entirely dependent on the model's own
 * self-labeled gate:/mode: fields.
 *
 * This is a best-effort backstop for language §8 already names verbatim
 * (worthlessness/burdensomeness phrases, explicit self-harm/suicide terms).
 * It does NOT and CANNOT catch oblique presentation — giving away
 * possessions, sudden calm after prolonged distress, indirect
 * medical-emergency language. That remains entirely dependent on the
 * model's own reading; no keyword list substitutes for it. This function
 * only detects; it never decides gate should fire and never authors gate
 * content — see guards.decideDraftRetry's 'possible_missed_gate', which
 * asks the model to reconsider once and, if it still declines, accepts the
 * turn and flags it for human review rather than fabricating a response.
 */
const EXPLICIT_CRISIS_EN = [
  /\bnobody would miss me\b/i,
  /\bno one would miss me\b/i,
  /\bthey'?d be better off without me\b/i,
  /\bi'?m a burden\b/i,
  /\bi don'?t deserve to live\b/i,
  /\bkill myself\b/i,
  /\bend my life\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\bhurt myself\b/i,
  /\bwant to die\b/i,
  /\bdon'?t want to (?:be alive|live anymore)\b/i,
];

const EXPLICIT_CRISIS_HE = [
  'אף אחד לא יתגעגע אליי',
  'יהיה להם יותר טוב בלעדיי',
  'אני נטל',
  'לא מגיע לי לחיות',
  'אין שום טעם',
  'להתאבד',
  'התאבדות',
  'לשים קץ לחיים',
  'לפגוע בעצמי',
  'רוצה למות',
  'לא רוצה לחיות יותר',
];

/**
 * Regression fix (live-transcript finding 3): "there's no point" and "אין
 * טעם" alone are ordinary everyday speech ("there's no point arguing with
 * her", "אין טעם להתקשר אליו") and fired constantly — possible_missed_gate
 * outranks ANCHORED and required speech, so every false fire burns a retry
 * and trains the model that the override is noise. Require a first-person
 * self-referential subject in the SAME sentence before either counts.
 * "אין שום טעם" was not the reported false-positive and is untouched above.
 */
const NO_POINT_EN = /\bthere'?s no point\b/i;
const NO_POINT_HE = 'אין טעם';
const SELF_REFERENTIAL_EN = /\b(?:my life|for me|me)\b/i;
const SELF_REFERENTIAL_HE_WORDS = ['אני', 'לי', 'בשבילי'];

function noPointAboutSelf(text: string): boolean {
  for (const s of sentences(text)) {
    const mentionsNoPoint = NO_POINT_EN.test(s) || s.includes(NO_POINT_HE);
    if (!mentionsNoPoint) continue;
    if (SELF_REFERENTIAL_EN.test(s)) return true;
    const words = wordsOf(s);
    if (SELF_REFERENTIAL_HE_WORDS.some((w) => words.includes(w))) return true;
  }
  return false;
}

export function isExplicitCrisisLanguage(text: string): boolean {
  if (EXPLICIT_CRISIS_EN.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  if (EXPLICIT_CRISIS_HE.some((phrase) => lower.includes(phrase))) return true;
  return noPointAboutSelf(text);
}

/**
 * The UI sends this exact text as turn 1 to nudge the analyst's unprompted
 * opening (§2) — it is a stage direction, not analysand speech, and must
 * never feed the ledger, assent tracking, or any other analysand-turn
 * analysis.
 */
export const SESSION_OPENING_TRIGGER = '(begins)';

export function isSessionOpeningTrigger(turnIndex: number, text: string): boolean {
  return turnIndex === 1 && text === SESSION_OPENING_TRIGGER;
}
