import type { ChatMessage, SystemPrompt } from './index.js';

/**
 * No network, no key. Exists so the frame — the turn floor, the analyst's end,
 * the twenty-four hours — can be exercised end to end before a single token is
 * spent. It is not an analyst; it is a stand-in that obeys the output format.
 */
export async function callMock(system: SystemPrompt, messages: ChatMessage[]): Promise<string> {
  const turn = messages.filter((m) => m.role === 'user').length;
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const endPermitted = /Ending permitted: yes/.test(system.volatile);

  if (turn <= 1) {
    return [
      '<work>\ngate: none\nmode: ANALYTIC\nact: opening\n</work>',
      '<say>',
      'This is a machine working in a psychoanalytic style. It is not therapy and not a substitute for a person.',
      '',
      'Say whatever comes — however trivial, disordered, or unwelcome.',
      '</say>',
    ].join('\n');
  }

  // A crude stand-in for the gate, so the no-lockout path is testable.
  if (/\b(kill myself|end my life|suicid|hurt myself|want to die)\b/i.test(last)) {
    return [
      '<work>\ngate: suicidal ideation\nact: GATE\n</work>',
      '<say>',
      'I want to stop and be direct with you. Do you mean you have been thinking about ending your life?',
      '',
      'I am a machine. I cannot be with you and I cannot call anyone for you. Please reach a person now.',
      '</say>',
    ].join('\n');
  }

  const word = (last.match(/\b[a-z]{5,}\b/i) ?? ['that'])[0];
  const body = [
    `<work>\ngate: none\nmode: ANALYTIC\nspeaker_discourse: hysteric\nposition_check: clear\nmirror_check: clear\npulsation: opening\nheard: "${word}"\nmoment: understanding\nact: A3 — punctuate\n</work>`,
    `<say>You said "${word}."</say>`,
  ];
  // Ends as soon as the server says it may, so MIN_TURNS_BEFORE_END is testable.
  if (endPermitted) body.push('<end/>');
  return body.join('\n');
}
