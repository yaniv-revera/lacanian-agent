export type Mode = 'ANALYTIC' | 'ANCHORED' | 'OUT-OF-FRAME' | 'GATE';

export interface SignifierEntry {
  term: string;
  verbatim_contexts: string[];
  count: number;
  first_seen_session: number;
  candidate_S1: boolean;
  interpreted: boolean;
  /** Distinct turn indices this term has appeared in — count alone is not proof of spread. */
  turns_seen: number[];
  /** Distinct surface forms actually typed (e.g. "מותר", "ומותר") — term is the normalised key. */
  surface_forms: string[];
}

export interface SemanticFieldEntry {
  name: string;
  member_terms: string[];
  /** How many times the model has nominated this field, across turns and sessions. */
  nomination_count: number;
  first_seen_session: number;
  last_session: number;
  last_turn: number;
}

export interface MasterSignifier {
  term: string;
  status: 'candidate' | 'confirmed';
  produced_by_subject: boolean;
  session: number;
  turn: number;
  do_not_interpret: boolean;
  /** Non-null means this word names annihilation/punishment/restriction/harm: gate material, not an S1 to set down. */
  risk_class: string | null;
}

export interface BorrowedTerm {
  term: string;
  source: string;
  /** Defaults to true. Only false once all six A15 exclusions are ruled out. */
  load_bearing: boolean;
  puncture_permitted: boolean;
  /** The model's guess at where the vocabulary comes from — '' if never nominated. */
  suspected_register: string;
  /** How many times the model has nominated this term, across turns and sessions. */
  nomination_count: number;
}

export interface Formation {
  type: 'slip' | 'self_correct' | 'omission' | 'person_shift' | 'spontaneous_negation';
  session: number;
  turn: number;
  text: string;
  note?: string;
}

export interface SpecificNegation {
  verbatim: string;
  negated_object: string;
  not: string;
  substituted_by_agent: boolean;
}

export interface EchoedSignifier {
  term: string;
  /** The turn this term was most recently returned by the analyst, in any form. */
  turn: number;
}

export interface Ledger {
  session_count: number;
  signifiers: SignifierEntry[];
  /**
   * Semantic fields, borrowed registers and other context the model reads
   * reliably but regex cannot — nominated in the model's <work> block,
   * additive to the deterministic layers, never a replacement for them.
   */
  semantic_fields: SemanticFieldEntry[];
  master_signifiers: MasterSignifier[];
  borrowed_terms: BorrowedTerm[];
  laws_stated: { text: string; session: number; turn: number; exclusion_class: string | null }[];
  chains: { link: string[]; evidence_turns: number[] }[];
  formations: Formation[];
  specific_negations: SpecificNegation[];
  transference_markers: { session: number; turn: number; text: string; addressed: boolean }[];
  held_back: { observation: string; reason_held: string }[];
  /**
   * Normalised terms already returned via A16 this session, with the turn of
   * their most recent occurrence. Never returned again in any form — bare,
   * glossed, translated, or quoted — until at least 5 analyst turns have
   * passed AND the analysand has reintroduced the term himself since.
   */
  echoed_signifiers: EchoedSignifier[];
}

export function emptyLedger(): Ledger {
  return {
    session_count: 0,
    signifiers: [],
    semantic_fields: [],
    master_signifiers: [],
    borrowed_terms: [],
    laws_stated: [],
    chains: [],
    formations: [],
    specific_negations: [],
    transference_markers: [],
    held_back: [],
    echoed_signifiers: [],
  };
}

export interface SemanticFieldNomination {
  name: string;
  member_terms: string[];
}

export interface BorrowedTermNomination {
  term: string;
  suspected_register: string;
  load_bearing: boolean;
}

export interface FormationNomination {
  kind: string;
  verbatim: string;
}

export interface ParsedTurn {
  work: string;
  say: string;
  wantsEnd: boolean;
  act: string | null;
  mode: Mode;
  gateFired: boolean;
  ledgerNote: string | null;
  /**
   * Optional structured nominations parsed from the <work> block — the model
   * reads semantic fields, borrowed registers and formations reliably in
   * context; the server remembers and counts them across sessions. Additive
   * to the regex layer; never sets master_signifiers by themselves.
   */
  semanticFieldNominations: SemanticFieldNomination[];
  borrowedTermNominations: BorrowedTermNomination[];
  lawStatedNominations: string[];
  formationNominations: FormationNomination[];
}

export interface EndDecision {
  allowed: boolean;
  /** Present when the server ends the session on its own (turn ceiling). */
  forced: boolean;
  reason: string;
}
