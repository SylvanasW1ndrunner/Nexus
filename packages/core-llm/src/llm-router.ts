import type { UsageTracker } from '@dbagent/core-usage';
import type { LlmChatRequest, LlmChatResponse, LlmProvider } from './types.js';

export type LlmRouteMode = 'byok' | 'subscription';

export type LlmRouteDecision = {
  mode: LlmRouteMode;
  endpointDescription: string;
  requiresLogin: boolean;
};

export class LlmRouter {
  private readonly providers = new Map<string, LlmProvider>();

  constructor(
    private readonly usageTracker: UsageTracker,
    providers: LlmProvider[] = [],
  ) {
    for (const provider of providers) {
      this.registerProvider(provider);
    }
  }

  async decide(mode: LlmRouteMode): Promise<LlmRouteDecision> {
    await this.usageTracker.current();
    if (mode === 'subscription') {
      return {
        mode,
        endpointDescription: 'DBAgent Gateway',
        requiresLogin: true,
      };
    }
    return {
      mode,
      endpointDescription: 'User configured OpenAI-compatible endpoint',
      requiresLogin: false,
    };
  }

  registerProvider(provider: LlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  async chat(providerId: string, request: LlmChatRequest): Promise<LlmChatResponse> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`LLM provider is not registered: ${providerId}`);
    }

    const response = await provider.chat(request);
    if (response.usage?.totalTokens) {
      await this.usageTracker.recordByokTokens(response.usage.totalTokens);
    }
    return response;
  }
}
