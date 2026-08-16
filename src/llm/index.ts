import { config } from '../config.js';
import { callAnthropic } from './anthropic.js';
import { callOpenAI } from './openai.js';
import { callMock } from './mock.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The stable half is cacheable; the volatile half changes every turn. */
export interface SystemPrompt {
  stable: string;
  volatile: string;
}

export interface LLMProvider {
  name: string;
  complete(system: SystemPrompt, messages: ChatMessage[]): Promise<string>;
}

/**
 * Temperature is deliberately not low. The position tolerates variance;
 * what it does not tolerate is fluency in the wrong place, and that is
 * handled by the prompt and by guards.ts, not by sampling.
 */
export const TEMPERATURE = 0.8;
export const MAX_TOKENS = 1600;

export function getProvider(): LLMProvider {
  switch (config.provider) {
    case 'mock':
      return { name: 'mock', complete: callMock };
    case 'openai':
      return { name: `openai:${config.openaiModel}`, complete: callOpenAI };
    case 'anthropic':
    default:
      return { name: `anthropic:${config.anthropicModel}`, complete: callAnthropic };
  }
}
