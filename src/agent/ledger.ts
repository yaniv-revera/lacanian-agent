import type { EchoedSignifier, Ledger } from '../types.js';

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
 * question words, quantifiers) but are standalone words only — Hebrew
 * attaches ו/ה/ב/כ/ל/מ/ש directly to the following word with no space
 * (e.g. "שזה", "וגם"), and a fused prefix+word token will not match either
 * list. That needs a morphological stemmer, not a word list; not attempted
 * here.
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
]);

const LAW_PATTERNS = [
  /\bi'?m (?:just )?(?:someone|somebody|a person) who\b/i,
  /\bthat'?s (?:just )?(?:how it is|the reality|life)\b/i,
  /\bi (?:can'?t|cannot) [a-z]/i,
  /\bi'?ll never\b/i,
  /\bi always\b/i,
];

const NEGATION_PATTERNS = [
  /\b(?:he|she|they|we|you|it)\s+never\s+([a-z][^.!?]*)/i,
  /\bnobody\s+(?:ever\s+)?([a-z][^.!?]*)/i,
  /\bno\s+one\s+(?:ever\s+)?([a-z][^.!?]*)/i,
  /\bi\s+never\s+(?:got|had|received)\s+([a-z][^.!?]*)/i,
];

const SPONTANEOUS_NEGATION = /\b(?:it'?s not that|i'?m not saying|not because|it wasn'?t that)\b/i;

const TRANSFERENCE = [
  /\byou'?re the only\b/i,
  /\bthe only one who\b/i,
  /\byou (?:really )?(?:get|understand) me\b/i,
  /\bi (?:can )?only talk to you\b/i,
  /\bi'?ve been waiting (?:all day )?(?:for|to talk)\b/i,
];

const DESUPPOSITION = [
  /\byou'?re (?:just|only) (?:a|an) (?:machine|bot|program|ai|algorithm)\b/i,
  /\bthis is pointless\b/i,
  /\byou don'?t (?:actually |really )?know (?:anything|me)\b/i,
];

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
  const words = wordsOf(text);
  const seenThisTurn = new Set<string>();
  for (const w of words) {
    if (STOP.has(w) || seenThisTurn.has(w)) continue;
    seenThisTurn.add(w);
    const ctx = sents.find((s) => s.toLowerCase().includes(w)) ?? text.slice(0, 160);
    const existing = l.signifiers.find((s) => s.term === w);
    if (existing) {
      existing.count += 1;
      if (!existing.verbatim_contexts.includes(ctx)) existing.verbatim_contexts.push(ctx);
      if (existing.verbatim_contexts.length > 6) existing.verbatim_contexts.shift();
      if (existing.count >= 4) existing.candidate_S1 = true;
    } else {
      l.signifiers.push({
        term: w,
        verbatim_contexts: [ctx],
        count: 1,
        first_seen_session: sessionIndex,
        candidate_S1: false,
        interpreted: false,
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
    if (SPONTANEOUS_NEGATION.test(s)) {
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

  // --- borrowed terms: load_bearing defaults to true, nothing is punctured unchecked ---
  const lower = text.toLowerCase();
  for (const term of BORROWED) {
    if (lower.includes(term) && !l.borrowed_terms.some((b) => b.term === term)) {
      l.borrowed_terms.push({
        term,
        source: 'unknown',
        load_bearing: true,
        puncture_permitted: false,
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
