import type { AgentInvocationProjection } from '../events/event-projectors.js';
import type { CanonicalToolIdFact, ToolPermissionAuditFact } from '../events/agent-event.js';
import { AGENT_EVENT_SCHEMA_REGISTRY } from '../events/event-schema-registry.js';
import type { PreparedToolIntent } from './tool-protocol.js';
import { preparedIntentDigest } from './prepared-invocation.js';
import { validateToolQuestionBundle } from './tool-question.js';

/** Reject an unrepresentable intent before its first durable commit, using the real event schemas. */
export function assertPreparedLifecycleRepresentable(
  invocation: AgentInvocationProjection,
  intent: PreparedToolIntent,
  canonicalToolId: CanonicalToolIdFact,
  catalogRevision: string,
  deadline: string,
): void {
  const intentDigest = preparedIntentDigest(intent);
  const permissionAudit: ToolPermissionAuditFact = {
    mode: 'default', decision: 'ask', policyRevision: 'p'.repeat(128),
    // Upper bound of policy metadata; PermissionManager enforces the same limits.
    matchedRuleIds: Array.from({ length: 128 }, (_, index) => String(index).padEnd(2_048, 'r')),
    facts: structuredClone(intent.permission) as ToolPermissionAuditFact['facts'],
  };
  const prepared = {
    invocationId: invocation.invocationId, actionSummary: intent.action.summary,
    canonicalToolId, catalogRevision, deadline, intent, intentDigest,
    toolRevision: intent.toolRevision, recoveryClass: intent.recoveryClass,
    proposedRevision: invocation.revision,
  };
  AGENT_EVENT_SCHEMA_REGISTRY['tool.prepared'].validate(prepared);
  if (invocation.name === 'ask_user' && intent.input.bundle !== undefined) {
    validateToolQuestionBundle(intent.input.bundle);
    const bundle = intent.input.bundle;
    AGENT_EVENT_SCHEMA_REGISTRY['tool.waiting_for_user'].validate({ invocationId: invocation.invocationId, intentDigest, questionId: bundle.questionId, questionRevision: bundle.questionRevision, bundle });
  }
  AGENT_EVENT_SCHEMA_REGISTRY['tool.permission_evaluated'].validate({ invocationId: invocation.invocationId, intentDigest, permissionAudit });
  AGENT_EVENT_SCHEMA_REGISTRY['tool.started'].validate({
    invocationId: invocation.invocationId, intentDigest, permissionAudit,
    access: intent.access, concurrency: intent.concurrency, resourceKeys: intent.resourceKeys,
    idempotencyKey: 'i'.repeat(128), fencingToken: 1, attempt: 1, runRevision: 1,
  });
  const approval = {
    approvalId: 'a'.repeat(128), projectId: invocation.projectId, sessionId: invocation.sessionId,
    runId: invocation.runId, turnId: invocation.turnId, invocationId: invocation.invocationId,
    canonicalToolId, toolRevision: intent.toolRevision, recoveryClass: intent.recoveryClass,
    intentDigest, proposedRevision: invocation.revision, status: 'pending',
  };
  AGENT_EVENT_SCHEMA_REGISTRY['tool.approval_requested'].validate({ approval, summary: intent.action.summary });
  AGENT_EVENT_SCHEMA_REGISTRY['tool.authorized'].validate({ approvalId: approval.approvalId, invocationId: invocation.invocationId, intentDigest });
  AGENT_EVENT_SCHEMA_REGISTRY['tool.denied'].validate({ approvalId: approval.approvalId, invocationId: invocation.invocationId, intentDigest, reason: intent.action.summary });
  AGENT_EVENT_SCHEMA_REGISTRY['tool.failed'].validate({ intentDigest, summary: intent.action.summary, resultRefs: [], evidenceRefs: [] });
}
