import type {
  AgentToolApproval,
  AgentToolExecutionGrant,
  AgentToolExecutionGrantClaim,
} from './types.js';

/**
 * Create an in-memory execution grant that can be claimed exactly once.
 *
 * The grant is scoped to the approved Session and Tool Call. Failed scope
 * checks do not consume it, while a successful claim consumes it before the
 * database operation starts so retries require a new user approval.
 */
export function createSingleToolCallExecutionGrant(
  approval: AgentToolApproval,
): AgentToolExecutionGrant {
  let available = true;
  return Object.freeze({
    scope: 'single-tool-call' as const,
    sessionId: approval.sessionId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    grantedPermission: approval.grantedPermission,
    claim(input: AgentToolExecutionGrantClaim): AgentToolApproval | undefined {
      if (!available || !matchesApprovalScope(approval, input)) return undefined;
      available = false;
      return approval;
    },
  });
}

function matchesApprovalScope(
  approval: AgentToolApproval,
  input: AgentToolExecutionGrantClaim,
): boolean {
  return (
    input.sessionId === approval.sessionId &&
    input.toolCallId === approval.toolCallId &&
    input.toolName === approval.toolName &&
    input.requiredPermission === approval.grantedPermission
  );
}
