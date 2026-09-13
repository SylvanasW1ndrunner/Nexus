import type { CanonicalModelRequest } from './protocol/codec.js';
import type { ModelContentBlock } from './protocol/content.js';
import type { LlmMessage } from './types.js';

/** A deterministic planning estimate; endpoint usage remains authoritative. */
export function estimateCanonicalRequestTokens(request: CanonicalModelRequest): number {
  let tokens = 3;
  for (const message of request.messages) {
    tokens += 4;
    for (const block of message.content) {
      tokens += 2 + estimateBlockTokens(block);
    }
  }
  for (const tool of request.tools ?? []) {
    tokens += 6 + textTokens(tool.name) + textTokens(tool.description ?? '');
    tokens += textTokens(JSON.stringify(tool.inputSchema));
  }
  return tokens;
}

/** Planning-only estimate for the normalized direct-LLM compatibility edge. */
export function estimateLegacyMessagesTokens(messages: readonly LlmMessage[]): number {
  return messages.reduce((total, message) => {
    const structuredToolTokens = message.toolCalls?.length
      ? estimateTextTokens(JSON.stringify(message.toolCalls))
      : 0;
    return total + 4 + estimateTextTokens(message.content) + structuredToolTokens;
  }, 2);
}

/** Deterministic fallback used only when a provider/tokenizer supplies no count. */
export function estimateTextTokens(value: string): number {
  if (value.length === 0) return 0;
  let units = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x2e80) units += 2.4;
    else if (/\s/u.test(character)) units += 0.25;
    else units += 0.65;
  }
  return Math.max(1, Math.ceil(units));
}

function estimateBlockTokens(block: ModelContentBlock): number {
  if (block.type === 'text' || block.type === 'reasoning-summary') return textTokens(block.text);
  if (block.type === 'resource-ref') {
    return textTokens(block.artifactId) + textTokens(block.mediaType) + 2;
  }
  if (block.type === 'provider-opaque') return textTokens(JSON.stringify(block.value));
  if (block.type === 'tool-call') {
    return textTokens(block.callId) + textTokens(block.name) + textTokens(JSON.stringify(block.arguments));
  }
  return textTokens(block.callId) + textTokens(JSON.stringify(block.output));
}

function textTokens(value: string): number {
  return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
}
