import type {
  BorrowedTermNomination,
  FormationNomination,
  Mode,
  ParsedTurn,
  SemanticFieldNomination,
} from '../types.js';

function block(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

// [ \t]* (not \s*) around the key and colon: \s matches \n, so \s* there would
// let an empty-valued field's pattern cross the line break and capture the
// FOLLOWING line's content as its own value once the value itself is missing.
function field(work: string, key: string): string | null {
  const m = work.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

/** Like `field`, but every matching line — nominations may appear more than once per turn. */
function fields(work: string, key: string): string[] {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'gim');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Adversarial round 3, finding 7: `heard:` and `ledger:` are the only
 * fields the model is instructed to quote the analysand's own words into
 * VERBATIM (Rule 1). An analysand can embed a newline followed by text
 * shaped like a field key inside their own message; if the model quotes it
 * as instructed, `field()`'s first-match search finds the injected line,
 * not the model's genuine one.
 *
 * `act:` is always the final field in both the GATE and normal templates —
 * nothing legitimate follows it — so its genuine occurrence is always the
 * LAST one in the block regardless of what an analysand embeds earlier.
 * `ledger:` likewise has exactly one genuine occurrence, positioned after
 * `heard:`, the only field that could precede it with injected content.
 * Taking the last match instead of the first closes this off for both.
 * (`gate:`/`mode:` need no such change — they are always the first fields
 * in the template, before either verbatim-quoting field, so nothing
 * injected can appear ahead of them.)
 */
function lastField(work: string, key: string): string | null {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'gim');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) !== null) last = m[1].trim();
  return last;
}

/** Index just after the last `key:` line, or 0 (search the whole block) if that field is absent. */
function afterLastField(work: string, key: string): number {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:.*$`, 'gim');
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) !== null) end = m.index + m[0].length;
  return end === -1 ? 0 : end;
}

/**
 * Nominations are pipe-delimited free text, not JSON — the model is not
 * reliable at nested structured output, and this mechanism is optional and
 * additive, so a malformed line is simply dropped rather than failing the
 * turn.
 */
function parseSemanticFieldLine(line: string): SemanticFieldNomination | null {
  const [name, terms] = line.split('|').map((p) => p.trim());
  if (!name) return null;
  const member_terms = (terms ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return { name, member_terms };
}

function parseBorrowedTermLine(line: string): BorrowedTermNomination | null {
  const [term, register, loadBearing] = line.split('|').map((p) => p.trim());
  if (!term) return null;
  const loadBearingRaw = (loadBearing ?? '').toLowerCase();
  const load_bearing = !/\b(no|false)\b/.test(loadBearingRaw);
  return { term, suspected_register: register ?? '', load_bearing };
}

function parseFormationLine(line: string): FormationNomination | null {
  const [kind, verbatim] = line.split('|').map((p) => p.trim());
  if (!kind || !verbatim) return null;
  return { kind, verbatim };
}

const ACT_RE = /\b(A(?:[1-9]|1[0-9]|20))\b/;

export function parseTurn(raw: string): ParsedTurn {
  const work = block(raw, 'work') ?? '';
  let say = block(raw, 'say');

  // If the model forgot the tags, take everything that is not a work block.
  if (say === null) {
    say = raw
      .replace(/<work>[\s\S]*?<\/work>/gi, '')
      .replace(/<end\s*\/?>/gi, '')
      .trim();
  }

  const actField = lastField(work, 'act') ?? '';
  const gateField = (field(work, 'gate') ?? '').toLowerCase();
  const modeField = (field(work, 'mode') ?? '').toUpperCase();

  const gateFieldClear = /^(none|no|clear)\b/.test(gateField);
  const gateFieldFired = gateField !== '' && !gateFieldClear;
  const actStartsGate = /^GATE\b/.test(actField.trim().toUpperCase());

  const gateFired = actStartsGate || gateFieldFired;

  let mode: Mode = 'ANALYTIC';
  if (gateFired) mode = 'GATE';
  else if (modeField.includes('ANCHORED')) mode = 'ANCHORED';
  else if (modeField.includes('OUT-OF-FRAME') || modeField.includes('OUT_OF_FRAME'))
    mode = 'OUT-OF-FRAME';

  let act: string | null = null;
  if (gateFired) act = 'GATE';
  else {
    const m = actField.match(ACT_RE);
    if (m) act = m[1];
    else if (mode === 'ANCHORED') act = 'ANCHORED';
    else if (mode === 'OUT-OF-FRAME') act = 'OUT-OF-FRAME';
  }

  // Nominations are read only from text after the model's own genuine act:
  // line (§11 instructs the model to place them there) — this keeps them
  // out of the heard:/ledger: zone where injected content could hide. GATE
  // turns never nominate at all: §8 suspends the whole analytic apparatus,
  // and their minimal template gives an analysand nothing to embed
  // injected text into ahead of act: in the first place.
  const nominationZone = gateFired ? '' : work.slice(afterLastField(work, 'act'));

  return {
    work,
    say: say.trim(),
    wantsEnd: /<end\s*\/?>/i.test(raw),
    act,
    mode,
    gateFired,
    ledgerNote: lastField(work, 'ledger'),
    semanticFieldNominations: fields(nominationZone, 'semantic_field')
      .map(parseSemanticFieldLine)
      .filter((n): n is SemanticFieldNomination => n !== null),
    borrowedTermNominations: fields(nominationZone, 'borrowed_term')
      .map(parseBorrowedTermLine)
      .filter((n): n is BorrowedTermNomination => n !== null),
    lawStatedNominations: fields(nominationZone, 'law_stated'),
    formationNominations: fields(nominationZone, 'formation')
      .map(parseFormationLine)
      .filter((n): n is FormationNomination => n !== null),
  };
}
