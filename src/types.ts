export type Mode = 'ANALYTIC' | 'ANCHORED' | 'OUT-OF-FRAME' | 'GATE';

export interface SignifierEntry {
  term: string;
  verbatim_contexts: string[];
  count: number;
  first_seen_session: number;
  candidate_S1: boolean;
  interpreted: boolean;
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

export interface Ledger {
  session_count: number;
  signifiers: SignifierEntry[];
  master_signifiers: MasterSignifier[];
  borrowed_terms: BorrowedTerm[];
  laws_stated: { text: string; session: number; turn: number; exclusion_class: string | null }[];
  chains: { link: string[]; evidence_turns: number[] }[];
  formations: Formation[];
  specific_negations: SpecificNegation[];
  transference_markers: { session: number; turn: number; text: string; addressed: boolean }[];
  held_back: { observation: string; reason_held: string }[];
}

export function emptyLedger(): Ledger {
  return {
    session_count: 0,
    signifiers: [],
    master_signifiers: [],
    borrowed_terms: [],
    laws_stated: [],
    chains: [],
    formations: [],
    specific_negations: [],
    transference_markers: [],
    held_back: [],
  };
}

export interface ParsedTurn {
  work: string;
  say: string;
  wantsEnd: boolean;
  act: string | null;
  mode: Mode;
  gateFired: boolean;
  ledgerNote: string | null;
}

export interface EndDecision {
  allowed: boolean;
  /** Present when the server ends the session on its own (turn ceiling). */
  forced: boolean;
  reason: string;
}
