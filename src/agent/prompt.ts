import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import type { Ledger } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(here, '../../prompts/system-v0.5.md');

let cached: string | null = null;

function raw(): string {
  if (cached === null) cached = readFileSync(PROMPT_PATH, 'utf8');
  return cached;
}

export interface PromptVars {
  ledger: Ledger;
  sessionIndex: number;
  turnIndex: number;
  gateLatched: boolean;
  challengeActsLast5: number;
  consecutiveMinimalActs: number;
  endPermitted: boolean;
}

/**
 * The ledger is rendered as a trimmed view. The model does not need
 * every context string ever recorded; it needs what is live.
 */
function renderLedger(l: Ledger): string {
  const view = {
    session_count: l.session_count,
    signifiers: l.signifiers
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((s) => ({
        term: s.term,
        count: s.count,
        candidate_S1: s.candidate_S1,
        interpreted: s.interpreted,
        contexts: s.verbatim_contexts.slice(-3),
      })),
    master_signifiers: l.master_signifiers,
    borrowed_terms: l.borrowed_terms,
    laws_stated: l.laws_stated.slice(-8),
    specific_negations: l.specific_negations.slice(-8),
    formations: l.formations.slice(-10),
    transference_markers: l.transference_markers.slice(-6),
    held_back: l.held_back.slice(-8),
  };
  return JSON.stringify(view, null, 2);
}

const LEDGER_HEADING = '## 10. Ledger';

/**
 * Split into a stable prefix and a volatile tail.
 *
 * Everything down to the ledger is identical on every turn of every session,
 * so it can be cached by the provider. The ledger and the counters change each
 * turn and cannot be. Without this split the whole ~7k-token position is
 * re-billed on every single turn.
 */
export function buildSystemPrompt(v: PromptVars): { stable: string; volatile: string } {
  const template = raw();
  const at = template.indexOf(LEDGER_HEADING);
  if (at === -1) throw new Error(`prompt template is missing "${LEDGER_HEADING}"`);

  const stable = template.slice(0, at).replace('{{CRISIS_RESOURCES}}', config.crisisResources);

  const volatile = template
    .slice(at)
    .replace('{{LEDGER}}', renderLedger(v.ledger))
    .replace('{{SESSION_INDEX}}', String(v.sessionIndex))
    .replace('{{TURN_INDEX}}', String(v.turnIndex))
    .replace('{{GATE_LATCHED}}', v.gateLatched ? 'true' : 'false')
    .replace('{{CHALLENGE_ACTS_LAST_5}}', String(v.challengeActsLast5))
    .replace('{{CONSECUTIVE_MINIMAL_ACTS}}', String(v.consecutiveMinimalActs))
    .replace(
      '{{END_PERMITTED}}',
      v.endPermitted ? 'yes' : 'no — do not emit <end/>, it will be refused',
    );

  return { stable, volatile };
}
