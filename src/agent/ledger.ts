import type { Ledger } from '../types.js';

/**
 * Deterministic listening support. This does not replace the model's reading —
 * it keeps a stable count across sessions so that "that word again" is a fact
 * and not an impression, and it flags the categories the spec says must never
 * be silently substituted.
 */

const STOP = new Set(
  `a an the and or but if then than that this these those i me my mine you your yours he him his she her
   it its we us our they them their am is are was were be been being do does did done have has had will
   would can could should shall may might must of in on at to for with from by about as so just really
   very not no yes what when where who whom how why there here get got go going went know think feel
   like said say says because into out up down over under again more most some any all one two`.split(
    /\s+/,
  ),
);

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
  const words = text.toLowerCase().match(/[a-z']{3,}/g) ?? [];
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

  // Keep the ledger bounded.
  l.signifiers = l.signifiers.filter((s) => s.count > 1 || s.candidate_S1).slice(-400);
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
