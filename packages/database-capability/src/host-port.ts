import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmEmbeddingResponse,
  LlmModelSelection,
  LlmRerankResponse,
} from '@dbagent/core-llm';

/**
 * The only authority a database Capability needs from its generic host.
 * It intentionally excludes AgentRuntime, registries, journals, settings,
 * and mutable model/Tool state.
 */
export type DatabaseCapabilityHostPort = Readonly<{
  project: Readonly<{
    projectId: string;
    tenantId: string;
    rootPath: string;
    configDirectory: string;
  }>;
  chat(
    request: Omit<LlmChatRequest, 'model'>,
    options: Readonly<{ model: LlmModelSelection; taskType: string; maxRetries: number }>,
  ): Promise<LlmChatResponse>;
  embed(input: Readonly<{
    selection: LlmModelSelection;
    input: readonly string[];
    dimensions?: number;
    context: Readonly<{ tenantId: string; taskType: string }>;
  }>): Promise<LlmEmbeddingResponse>;
  rerank(input: Readonly<{
    selection: LlmModelSelection;
    query: string;
    documents: readonly string[];
    topN?: number;
    context: Readonly<{ tenantId: string; taskType: string }>;
  }>): Promise<LlmRerankResponse>;
  /**
   * Ask the host-owned Capability control plane to atomically publish a new
   * immutable database Tool generation. The database module never receives a
   * control-plane reference, so this callback must resolve only after that
   * publication succeeds.
   */
  requestCapabilityRefresh?(input: Readonly<{ reason: 'schema' }>): Promise<void>;
}>;
