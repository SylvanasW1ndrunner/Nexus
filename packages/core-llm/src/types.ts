export type LlmProviderMode = 'byok' | 'subscription';

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
};

export type LlmTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LlmChatRequest = {
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type LlmChatResponse = {
  text: string;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
  providerResponseId?: string;
  model?: string;
};

export type LlmChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'tool-call'; toolCall: LlmToolCall }
  | { type: 'usage'; usage: LlmUsage }
  | { type: 'finish'; response: LlmChatResponse; reason?: string };

export type LlmProviderAvailability = {
  available: boolean;
  detail?: string;
};

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;

  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  stream?(request: LlmChatRequest): AsyncIterable<LlmChatStreamEvent>;
  isAvailable(): Promise<LlmProviderAvailability>;
}

export type LlmErrorCode =
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_ABORTED'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_BAD_RESPONSE'
  | 'LLM_PROVIDER_ERROR';

export class LlmProviderError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
