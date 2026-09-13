import type { PreparedToolIntent } from './tool-protocol.js';
import type { ToolCatalogSnapshot } from '../tool-registry.js';

export type InvocationRecoveryDecision = 'unsupported_revision' | 'replay' | 'recover' | 'unknown';

/** Recovery never reparses original input or silently selects a current implementation. */
export function decideInvocationRecovery(intent: PreparedToolIntent, name: string, catalog: ToolCatalogSnapshot): InvocationRecoveryDecision {
  if (!catalog.supportsRevision({ toolName: name, toolRevision: intent.toolRevision, handlerRevision: intent.handlerRevision, intentRevision: intent.intentRevision })) return 'unsupported_revision';
  switch (intent.recoveryClass) {
    case 'read': case 'idempotent': return 'replay';
    case 'transactional': return 'recover';
    case 'non_idempotent': return 'unknown';
  }
}
