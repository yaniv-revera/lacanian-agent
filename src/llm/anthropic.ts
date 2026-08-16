import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { MAX_TOKENS, TEMPERATURE, type ChatMessage, type SystemPrompt } from './index.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export async function callAnthropic(
  system: SystemPrompt,
  messages: ChatMessage[],
): Promise<string> {
  const res = await getClient().messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      // The position is identical on every turn — cache it.
      { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system.volatile },
    ],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
