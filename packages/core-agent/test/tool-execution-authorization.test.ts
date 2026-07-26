import { describe, expect, it } from 'vitest';
import { createSingleToolCallExecutionGrant, type AgentToolApproval } from '../src/index.js';

describe('single Tool Call execution grants', () => {
  it('is claimable once by the exact approved Session, Tool Call, tool, and permission', () => {
    const approval = approvedUpdate();
    const grant = createSingleToolCallExecutionGrant(approval);
    const claim = {
      sessionId: 'session-a',
      toolCallId: 'update-1',
      toolName: 'sql_execute',
      requiredPermission: 'edit' as const,
    };

    expect(grant.claim(claim)).toBe(approval);
    expect(grant.claim(claim)).toBeUndefined();
  });

  it('cannot be claimed by another Session, a later Tool Call, another tool, or higher SQL permission', () => {
    const cases = [
      {
        sessionId: 'session-b',
        toolCallId: 'update-1',
        toolName: 'sql_execute',
        requiredPermission: 'edit' as const,
      },
      {
        sessionId: 'session-a',
        toolCallId: 'update-2',
        toolName: 'sql_execute',
        requiredPermission: 'edit' as const,
      },
      {
        sessionId: 'session-a',
        toolCallId: 'update-1',
        toolName: 'workspace_write',
        requiredPermission: 'edit' as const,
      },
      {
        sessionId: 'session-a',
        toolCallId: 'update-1',
        toolName: 'sql_execute',
        requiredPermission: 'full' as const,
      },
    ];

    for (const claim of cases) {
      const grant = createSingleToolCallExecutionGrant(approvedUpdate());
      expect(grant.claim(claim)).toBeUndefined();
    }
  });
});

function approvedUpdate(): AgentToolApproval {
  return {
    granted: true,
    source: 'approval-provider',
    sessionId: 'session-a',
    toolCallId: 'update-1',
    toolName: 'sql_execute',
    grantedPermission: 'edit',
    approvedAt: '2026-07-26T00:00:00.000Z',
    requestId: 'approval-update-1',
  };
}
