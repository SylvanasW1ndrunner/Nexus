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

const TERMINAL_FAILURE_FINAL_PATTERNS = [
  /(?:失败|错误|拒绝|未获批准|未批准|未执行|没有执行|超时|取消|无法|不能|只读)/,
  /\b(?:denied|rejected|failed|error|timeout|timed out|cancelled|canceled|unable|cannot|could not|read[- ]only)\b/i,
  /\bnot\s+(?:approved|executed|completed)\b/i,
];

export function verifyAgentCompletion(input: {
  taskPlan?: AgentTaskPlan;
  toolExecutions: readonly AgentToolExecutionRecord[];
  proposedFinalText: string;
}): AgentCompletionVerification {
  // The model-owned plan is execution guidance, not an evidence source or a
  // user-facing completion gate. Runtime evidence below is authoritative.
  const unresolvedTaskIds: string[] = [];
  const evidence = input.toolExecutions
    .filter((execution) => execution.status === 'success' && execution.completionEvidence)
    .map((execution) => execution.completionEvidence!);
  const evidenceKinds = [...new Set(evidence.map((item) => item.kind))];
  const sqlExecutions = input.toolExecutions.filter(
    (execution) => execution.toolName === 'sql_execute',
  );
  const latestSqlExecution = sqlExecutions.at(-1);
  const latestSqlEvidence = latestSqlExecution?.completionEvidence;
  const terminalFailureDelivered =
    latestSqlExecution !== undefined &&
    latestSqlExecution.status !== 'success' &&
    isTerminalFailureResponse(input.proposedFinalText);
  const deliveryReady =
    latestSqlExecution === undefined
      ? evidence.length === 0 || evidence.some((item) => item.deliveryReady)
      : latestSqlExecution.status === 'success'
        ? latestSqlEvidence?.deliveryReady === true
        : terminalFailureDelivered;
  const missing: string[] = [];
  if (
    latestSqlExecution?.status !== undefined &&
    latestSqlExecution.status !== 'success' &&
    !terminalFailureDelivered
  ) {
    missing.push('the latest SQL execution did not succeed');
  } else if (latestSqlExecution?.status === 'success' && latestSqlEvidence === undefined) {
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

function isTerminalFailureResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || !isFinalResponseReady(normalized)) return false;
  return TERMINAL_FAILURE_FINAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function completionCorrectionMessage(
  verification: AgentCompletionVerification,
): string {
  if (!verification.verified) {
    return [
      'Completion verification failed.',
      `Missing evidence: ${verification.missing.join('; ')}.`,
      'Recover with a corrected action when possible. If the operation is terminally denied, cancelled, timed out, or blocked by a hard database boundary, explicitly deliver that failure outcome instead of claiming success.',
    ].join('\n');
  }
  return [
    'Finalize the task now.',
    'The previous response described future work instead of delivering the completed outcome.',
    'Do not announce another check. Give the concise final answer from the verified evidence; database rows are delivered separately by the runtime.',
  ].join('\n');
}
