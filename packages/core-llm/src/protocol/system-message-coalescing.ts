import type { LlmMessage } from '../types.js';

/**
 * Adapts the normalized message surface to endpoints that accept one leading
 * system message while preserving the transcript order of every other role.
 */
export function coalesceSystemMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.length > 0);
  const transcript = messages.filter((message) => message.role !== 'system');
  return system.length === 0
    ? [...transcript]
    : [{ role: 'system', content: system.join('\n\n') }, ...transcript];
}
