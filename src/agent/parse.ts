import type { Mode, ParsedTurn } from '../types.js';

function block(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function field(work: string, key: string): string | null {
  const m = work.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
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

  const actField = field(work, 'act') ?? '';
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

  return {
    work,
    say: say.trim(),
    wantsEnd: /<end\s*\/?>/i.test(raw),
    act,
    mode,
    gateFired,
    ledgerNote: field(work, 'ledger'),
  };
}
