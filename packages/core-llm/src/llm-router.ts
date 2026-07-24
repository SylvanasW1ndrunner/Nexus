import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import { LlmGateway } from './llm-gateway.js';
import type { LlmChatRequest, LlmChatResponse, LlmChatStreamEvent, LlmProvider, LlmProviderCapabilities } from './types.js';

export type LlmRouteMode = 'byok' | 'managed';

export type LlmLegacyRouteDecision = {
  mode: LlmRouteMode;
  endpointDescription: string;
};

export type LlmChatOptions = {
  round?: RoundContext;
};

/**
 * Backwards-compatible facade. New code should depend on LlmGateway directly.
 * Every legacy call is still executed through the gateway policy, accounting,
 * reliability, validation and telemetry pipeline.
 */
export class LlmRouter {
  readonly gateway: LlmGateway;

  constructor(
    private readonly usageTracker: UsageTracker,
    providers: LlmProvider[] = [],
  ) {
    this.gateway = new LlmGateway({ usageTracker });
    for (const provider of providers) this.registerProvider(provider);
  }

  async decide(mode: LlmRouteMode): Promise<LlmLegacyRouteDecision> {
    await this.usageTracker.current();
    return mode === 'managed'
      ? { mode, endpointDescription: 'Organization-managed OpenAI-compatible endpoint' }
      : { mode, endpointDescription: 'User configured OpenAI-compatible endpoint' };
  }

  registerProvider(provider: LlmProvider): void {
    this.gateway.registerProvider(provider);
  }

  async chat(providerId: string, request: LlmChatRequest, options: LlmChatOptions = {}): Promise<LlmChatResponse> {
    this.registerLegacyModel(providerId, request, false);
    return await this.gateway.chat({
      providerId,
      request,
      context: { tenantId: 'legacy-local', taskType: 'legacy-chat' },
      ...(options.round === undefined ? {} : { round: options.round }),
      maxRetries: 0,
      maxFallbacks: 0,
      validateToolCalls: false,
    });
  }

  async *stream(
    providerId: string,
    request: LlmChatRequest,
    options: LlmChatOptions = {},
  ): AsyncIterable<LlmChatStreamEvent> {
    this.registerLegacyModel(providerId, request, true);
    yield* this.gateway.stream({
      providerId,
      request,
      context: { tenantId: 'legacy-local', taskType: 'legacy-stream' },
      ...(options.round === undefined ? {} : { round: options.round }),
      maxRetries: 0,
      maxFallbacks: 0,
      validateToolCalls: false,
    });
  }

  private registerLegacyModel(providerId: string, request: LlmChatRequest, streaming: boolean): void {
    const provider = this.gateway.registry.provider(providerId);
    if (!provider) throw new Error(`LLM provider is not registered: ${providerId}`);
    const capabilities: Partial<LlmProviderCapabilities> = {
      ...(request.tools?.length ? { toolCalling: 'supported' } : {}),
      ...(request.responseFormat && request.responseFormat.type !== 'text' ? { structuredOutput: 'supported' } : {}),
      ...(streaming ? { streaming: 'supported' } : {}),
    };
    const existing = this.gateway.registry.find(providerId, request.model);
    if (!existing) {
      this.gateway.registerModel({
        providerId,
        model: request.model,
        capabilities,
      });
      return;
    }
    for (const [name, status] of Object.entries(capabilities)) {
      if (status === undefined) continue;
      this.gateway.registry.updateCapability(
        existing.id,
        name as keyof LlmProviderCapabilities,
        status,
      );
    }
  }
}
