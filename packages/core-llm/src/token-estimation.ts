import type { CanonicalModelRequest } from './protocol/codec.js';
import type { ModelContentBlock } from './protocol/content.js';

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
