import type {
  AgentMode,
  ApprovalProvider,
  ApprovalProviderResult,
  PermissionRequest,
  ToolPermissionDecision,
} from './types.js';

export type PermissionCheckSource = 'automatic' | 'approval-provider' | 'missing-approval-provider';

export type PermissionCheckResult = {
  decision: ToolPermissionDecision;
  source: PermissionCheckSource;
  approvalRequestId?: string;
  approvedAt?: string;
  approvedBy?: string;
  reason?: string;
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
    const approval = normalizeApprovalProviderResult(await this.approvalProvider(request));
    return {
      decision: approval.approved ? 'allow' : 'deny',
      source: 'approval-provider',
      ...(approval.requestId === undefined ? {} : { approvalRequestId: approval.requestId }),
      ...(approval.approvedAt === undefined ? {} : { approvedAt: approval.approvedAt }),
      ...(approval.approvedBy === undefined ? {} : { approvedBy: approval.approvedBy }),
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    };
  }
}

function normalizeApprovalProviderResult(result: ApprovalProviderResult): {
  approved: boolean;
  requestId?: string;
  approvedAt?: string;
  approvedBy?: string;
  reason?: string;
} {
  if (typeof result === 'boolean') return { approved: result };
  return result;
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
