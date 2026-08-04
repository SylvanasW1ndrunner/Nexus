export type LlmProviderMode = 'byok' | 'managed' | 'private';

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
};

export type JsonSchema = Record<string, unknown>;

export type LlmTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Optional structured namespace retained until the final Provider mapping step. */
  namespace?: string;
  outputSchema?: JsonSchema;
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
  cachedPromptTokens?: number;
  estimated?: boolean;
};

export type LlmResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: JsonSchema; strict?: boolean };

export type LlmReasoningOptions = {
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
};

export type LlmChatRequest = {
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: LlmResponseFormat;
  reasoning?: LlmReasoningOptions;
  stop?: string[];
  seed?: number;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
};

export type LlmChatResponse = {
  text: string;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
  providerResponseId?: string;
  model?: string;
  finishReason?: string;
};

export type LlmChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'tool-call'; toolCall: LlmToolCall }
  | { type: 'usage'; usage: LlmUsage }
  | { type: 'finish'; response: LlmChatResponse; reason?: string };

export type LlmEmbeddingRequest = {
  model: string;
  input: string[];
  dimensions?: number;
  signal?: AbortSignal;
};

export type LlmEmbeddingResponse = {
  embeddings: number[][];
  usage?: LlmUsage;
  model?: string;
};

export type LlmRerankRequest = {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  signal?: AbortSignal;
};

export type LlmRerankResult = {
  index: number;
  score: number;
  document?: string;
};

export type LlmRerankResponse = {
  results: LlmRerankResult[];
  usage?: LlmUsage;
  model?: string;
};

export type LlmProviderAvailability = {
  available: boolean;
  latencyMs?: number;
  detail?: string;
};

export type LlmModelMetadataSource = 'provider-api' | 'provider-declaration';

export type LlmModelMetadata = {
  model: string;
  source: LlmModelMetadataSource;
  capabilities: Partial<LlmProviderCapabilities>;
  contextTokens?: number;
  maxOutputTokens?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
};

export type LlmCapabilityName =
  | 'chat'
  | 'streaming'
  | 'toolCalling'
  | 'structuredOutput'
  | 'reasoning'
  | 'embeddings'
  | 'rerank';

export type LlmCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export type LlmProviderCapabilities = Record<LlmCapabilityName, LlmCapabilityStatus>;

export type LlmProviderProtocolCapabilityName =
  | 'nativeDeferredTools'
  | 'namespaceTools'
  | 'toolReferences'
  | 'parallelToolCalls'
  | 'structuredToolResults'
  | 'serverWebSearch'
  | 'promptCaching';

export type LlmProviderProtocolCapabilities = Record<
  LlmProviderProtocolCapabilityName,
  LlmCapabilityStatus
>;

export type LlmProviderProtocolProfileSource =
  | 'default'
  | 'builtin'
  | 'provider-api'
  | 'provider-declaration'
  | 'user-declaration';

/**
 * Transport features are deliberately separate from model intelligence.
 * A model may support tool calling while a proxy does not forward advanced
 * tool-reference or deferred-loading protocol fields.
 */
export type LlmProviderProtocolProfile = {
  protocol: string;
  source: LlmProviderProtocolProfileSource;
  capabilities: LlmProviderProtocolCapabilities;
};

export type LlmProviderProtocolProfileInput = Omit<
  LlmProviderProtocolProfile,
  'capabilities'
> & {
  capabilities?: Partial<LlmProviderProtocolCapabilities>;
};

export const UNKNOWN_LLM_CAPABILITIES: Readonly<LlmProviderCapabilities> = Object.freeze({
  chat: 'unknown',
  streaming: 'unknown',
  toolCalling: 'unknown',
  structuredOutput: 'unknown',
  reasoning: 'unknown',
  embeddings: 'unknown',
  rerank: 'unknown',
});

export const UNKNOWN_LLM_PROVIDER_PROTOCOL_CAPABILITIES: Readonly<LlmProviderProtocolCapabilities> =
  Object.freeze({
    nativeDeferredTools: 'unknown',
    namespaceTools: 'unknown',
    toolReferences: 'unknown',
    parallelToolCalls: 'unknown',
    structuredToolResults: 'unknown',
    serverWebSearch: 'unknown',
    promptCaching: 'unknown',
  });

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;
  readonly protocol?: string;
  readonly capabilities?: Partial<LlmProviderCapabilities>;
  readonly protocolProfile?: LlmProviderProtocolProfile;

  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  stream?(request: LlmChatRequest): AsyncIterable<LlmChatStreamEvent>;
  embed?(request: LlmEmbeddingRequest): Promise<LlmEmbeddingResponse>;
  rerank?(request: LlmRerankRequest): Promise<LlmRerankResponse>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
  getModelMetadata?(model: string, signal?: AbortSignal): Promise<LlmModelMetadata>;
  isAvailable(model?: string, signal?: AbortSignal): Promise<LlmProviderAvailability>;
}

export type LlmErrorCode =
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_ABORTED'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_BAD_RESPONSE'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_CAPABILITY_UNSUPPORTED'
  | 'LLM_NO_ROUTE'
  | 'LLM_POLICY_VIOLATION'
  | 'LLM_BUDGET_EXCEEDED'
  | 'LLM_QUEUE_FULL'
  | 'LLM_CIRCUIT_OPEN'
  | 'LLM_STRUCTURED_OUTPUT_INVALID';

export class LlmProviderError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export function isLlmProviderError(value: unknown): value is LlmProviderError {
  return value instanceof LlmProviderError;
}
