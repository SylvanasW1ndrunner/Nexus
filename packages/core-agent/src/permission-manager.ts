import type {
  AgentMode,
  ApprovalProvider,
  PermissionRequest,
  ToolPermissionDecision,
} from './types.js';

export type PermissionCheckSource = 'automatic' | 'approval-provider' | 'missing-approval-provider';

export type PermissionCheckResult = {
  decision: ToolPermissionDecision;
  source: PermissionCheckSource;
};

export class PermissionManager {
  constructor(private readonly approvalProvider?: ApprovalProvider) {}

  async check(request: PermissionRequest): Promise<ToolPermissionDecision> {
    return (await this.checkDetailed(request)).decision;
  }

  async checkDetailed(request: PermissionRequest): Promise<PermissionCheckResult> {
    const automatic = decideAutomaticPermission(request.mode, request.tool);
    if (automatic !== 'ask') return { decision: automatic, source: 'automatic' };
    if (!this.approvalProvider) return { decision: 'ask', source: 'missing-approval-provider' };
    return {
      decision: (await this.approvalProvider(request)) ? 'allow' : 'deny',
      source: 'approval-provider',
    };
  }
}

export function decideAutomaticPermission(
  mode: AgentMode,
  tool: { dangerLevel: 'safe' | 'medium' | 'high' | 'critical'; readonly?: boolean },
): ToolPermissionDecision {
  if (mode === 'readonly' && !tool.readonly) return 'deny';
  if (mode === 'readonly' && tool.readonly) return 'allow';
  if (tool.dangerLevel === 'critical') return mode === 'full-auto' ? 'ask' : 'deny';
  if (tool.dangerLevel === 'safe') return 'allow';
  if (mode === 'full-auto') return 'allow';
  if (mode === 'auto' && tool.dangerLevel === 'medium') return 'ask';
  return 'ask';
}
