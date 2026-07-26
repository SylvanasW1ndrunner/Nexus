import type {
  AgentMode,
  AgentAccessMode,
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

  async checkDetailed(
    request: PermissionRequest,
    onApprovalRequired?: (request: PermissionRequest) => void | Promise<void>,
  ): Promise<PermissionCheckResult> {
    const automatic = decideAutomaticPermission(request.mode, request.tool);
    if (automatic !== 'ask') return { decision: automatic, source: 'automatic' };
    if (!this.approvalProvider) return { decision: 'ask', source: 'missing-approval-provider' };
    await onApprovalRequired?.(request);
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
  tool: {
    dangerLevel: 'safe' | 'medium' | 'high' | 'critical';
    readonly?: boolean;
    requiredPermission?: AgentAccessMode;
  },
): ToolPermissionDecision {
  const required = requiredPermissionForTool(tool);
  if (accessRank(mode) >= accessRank(required)) return 'allow';
  return 'ask';
}

export function requiredPermissionForTool(tool: {
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical';
  readonly?: boolean;
  requiredPermission?: AgentAccessMode;
}): AgentAccessMode {
  if (tool.requiredPermission !== undefined) return tool.requiredPermission;
  if (tool.readonly || tool.dangerLevel === 'safe') return 'read';
  if (tool.dangerLevel === 'medium') return 'edit';
  return 'full';
}

function accessRank(mode: AgentAccessMode): number {
  if (mode === 'read') return 0;
  if (mode === 'edit') return 1;
  if (mode === 'full') return 2;
  throw new Error(`Unsupported Agent access mode: ${String(mode)}.`);
}
