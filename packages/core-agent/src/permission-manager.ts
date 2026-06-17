import type {
  AgentMode,
  ApprovalProvider,
  PermissionRequest,
  ToolPermissionDecision,
} from './types.js';

export class PermissionManager {
  constructor(private readonly approvalProvider?: ApprovalProvider) {}

  async check(request: PermissionRequest): Promise<ToolPermissionDecision> {
    const automatic = decideAutomaticPermission(request.mode, request.tool);
    if (automatic !== 'ask') return automatic;
    if (!this.approvalProvider) return 'ask';
    return (await this.approvalProvider(request)) ? 'allow' : 'deny';
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
