import type { UsageTracker } from '@dbagent/core-usage';

export type LlmRouteMode = 'byok' | 'subscription';

export type LlmRouteDecision = {
  mode: LlmRouteMode;
  endpointDescription: string;
  requiresLogin: boolean;
};

export class LlmRouter {
  constructor(private readonly usageTracker: UsageTracker) {}

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
}
