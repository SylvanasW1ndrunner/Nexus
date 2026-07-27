import { unresolvedAgentTasks } from './task-plan.js';
import type {
  AgentCompletionVerification,
  AgentTaskPlan,
  AgentToolExecutionRecord,
} from './types.js';

const PROCESS_ONLY_FINAL_PATTERNS = [
  /\b(?:let me|allow me|i(?:'ll| will))\b.{0,80}\b(?:verify|check|inspect|continue|confirm)\b/i,
  /\b(?:next|first)\s+(?:i(?:'ll| will)|step)\b.{0,80}\b(?:verify|check|inspect|continue)\b/i,
  /(?:让我|我来|接下来|下一步|稍后|将继续|正在).{0,40}(?:验证|核验|检查|确认|继续|查看)/,
];

export function verifyAgentCompletion(input: {
  taskPlan?: AgentTaskPlan;
  toolExecutions: readonly AgentToolExecutionRecord[];
  proposedFinalText: string;
}): AgentCompletionVerification {
  const unresolvedTaskIds = unresolvedAgentTasks(input.taskPlan).map((task) => task.id);
  const evidence = input.toolExecutions
    .filter((execution) => execution.status === 'success' && execution.completionEvidence)
    .map((execution) => execution.completionEvidence!);
  const evidenceKinds = [...new Set(evidence.map((item) => item.kind))];
  const sqlExecutions = input.toolExecutions.filter(
    (execution) => execution.toolName === 'sql_execute',
  );
  const latestSqlExecution = sqlExecutions.at(-1);
  const latestSqlEvidence = latestSqlExecution?.completionEvidence;
  const deliveryReady =
    latestSqlExecution === undefined
      ? evidence.length === 0 || evidence.some((item) => item.deliveryReady)
      : latestSqlExecution.status === 'success' && latestSqlEvidence?.deliveryReady === true;
  const missing: string[] = [];
  if (unresolvedTaskIds.length > 0) {
    missing.push(`unresolved plan tasks: ${unresolvedTaskIds.join(', ')}`);
  }
  if (latestSqlExecution?.status !== undefined && latestSqlExecution.status !== 'success') {
    missing.push('the latest SQL execution did not succeed');
  } else if (latestSqlExecution && latestSqlEvidence === undefined) {
    missing.push('completion evidence for the latest SQL execution');
  } else if (
    (latestSqlExecution !== undefined || evidence.length > 0) &&
    !deliveryReady
  ) {
    missing.push('a deliverable tool result or artifact');
  }
  const verified = missing.length === 0;
  const finalResponseReady = isFinalResponseReady(input.proposedFinalText);
  return {
    verified,
    deliveryReady,
    finalResponseReady,
    phase: verified ? 'finalize' : 'verify',
    unresolvedTaskIds,
    missing,
    evidenceKinds,
  };
}

export function isFinalResponseReady(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return !PROCESS_ONLY_FINAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function completionCorrectionMessage(
  verification: AgentCompletionVerification,
): string {
  if (!verification.verified) {
    return [
      'Completion verification failed.',
      `Missing evidence: ${verification.missing.join('; ')}.`,
      'Continue the task and obtain concrete evidence before proposing a final answer.',
    ].join('\n');
  }
  return [
    'Finalize the task now.',
    'The previous response described future work instead of delivering the completed outcome.',
    'Do not announce another check. Give the concise final answer from the verified evidence; database rows are delivered separately by the runtime.',
  ].join('\n');
}
