import { CompletionController, isFinalAgentResponse } from './completion-controller.js';
import type {
  AgentCompletionVerification,
  AgentTaskPlan,
  AgentToolExecutionRecord,
} from './types.js';

const defaultController = new CompletionController();

/** Backwards-compatible facade over the domain-neutral CompletionController. */
export function verifyAgentCompletion(input: {
  taskPlan?: AgentTaskPlan;
  toolExecutions: readonly AgentToolExecutionRecord[];
  proposedFinalText: string;
}): AgentCompletionVerification {
  return defaultController.verify(input);
}

export function isFinalResponseReady(text: string): boolean {
  return isFinalAgentResponse(text);
}

export function completionCorrectionMessage(
  verification: AgentCompletionVerification,
): string {
  if (!verification.verified) {
    return [
      'Completion verification failed.',
      `Missing evidence: ${verification.missing.join('; ')}.`,
      'Recover with a corrected action when possible. If the operation is terminally denied, cancelled, timed out, or blocked by a hard runtime boundary, explicitly deliver that failure outcome instead of claiming success.',
    ].join('\n');
  }
  return [
    'Finalize the task now.',
    'The previous response described future work or referred to hidden earlier output instead of delivering the completed outcome.',
    'Do not announce another check. Give the concise final answer from verified evidence; large results are delivered separately by the runtime.',
  ].join('\n');
}
