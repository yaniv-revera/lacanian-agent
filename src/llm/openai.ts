import OpenAI from 'openai';
import { config } from '../config.js';
import { MAX_TOKENS, TEMPERATURE, type ChatMessage, type SystemPrompt } from './index.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: config.openaiKey });
  return client;
}

export async function callOpenAI(
  system: SystemPrompt,
  messages: ChatMessage[],
): Promise<string> {
  const merged = `${system.stable}\n${system.volatile}`;
  const res = await getClient().chat.completions.create({
    model: config.openaiModel,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    messages: [{ role: 'system', content: merged }, ...messages],
  });
  return res.choices[0]?.message?.content ?? '';
}
