import { LlmProviderError, type LlmMessage, type LlmToolCall } from './types.js';

const TOOL_MARKUP_PATTERNS = [
  /<\/?tool[_-]?calls?\b/i,
  /<\|tool[_-]?calls?\|>/i,
  /<function(?:=|\s)[^>]*>/i,
  /(?:✿|◆)(?:FUNCTION|ARGS)(?:✿|◆)/i,
];

/**
 * Rejects provider/model protocol mismatch without attempting to reinterpret model text.
 * Parsing pseudo tool markup here would make retries non-idempotent and would hide an
 * endpoint configuration error from the caller.
 */
export function assertNoTextualToolInvocation(input: {
  text: string;
  toolCalls: readonly LlmToolCall[];
  toolsRequested: boolean;
  protocol: string;
}): void {
  if (!input.toolsRequested || input.toolCalls.length > 0 || !input.text.trim()) return;
  if (!TOOL_MARKUP_PATTERNS.some((pattern) => pattern.test(input.text))) return;

  throw new LlmProviderError(
    'TOOL_PROTOCOL_MISMATCH',
    `The model returned a tool invocation as text instead of ${input.protocol} structured tool data. Check the selected protocol and the model's native tool-calling support.`,
    false,
    undefined,
    { protocol: input.protocol },
  );
}

/**
 * Some OpenAI-compatible and local endpoints accept only one system message and
 * require it to be the first item. System layers have the same priority in our
 * canonical contract, so combining them is lossless while preserving the exact
 * order of the user/assistant/tool transcript.
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
