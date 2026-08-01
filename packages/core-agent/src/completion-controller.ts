import type {
  AgentCompletionVerification,
  AgentTaskPlan,
  AgentToolCompletionEvidence,
  AgentToolExecutionRecord,
} from './types.js';

export type CompletionControllerInput = {
  taskPlan?: AgentTaskPlan;
  toolExecutions: readonly AgentToolExecutionRecord[];
  proposedFinalText: string;
};

export type CompletionEvidenceEvaluation = {
  evidence: AgentToolCompletionEvidence[];
  deliveryReady: boolean;
  hasDeliverableAttempt?: boolean;
  missing?: string[];
};

export type CompletionEvidenceProvider = {
  id: string;
  evaluate(input: CompletionControllerInput): CompletionEvidenceEvaluation | undefined;
};

export class CompletionController {
  private readonly providers: readonly CompletionEvidenceProvider[];

  constructor(providers: readonly CompletionEvidenceProvider[] = []) {
    this.providers = [runtimeCompletionEvidenceProvider, ...providers];
  }

  verify(input: CompletionControllerInput): AgentCompletionVerification {
    const evaluations = this.providers
      .map((provider) => provider.evaluate(input))
      .filter((value): value is CompletionEvidenceEvaluation => value !== undefined);
    const runtime = evaluations[0] ?? {
      evidence: [],
      deliveryReady: true,
      hasDeliverableAttempt: false,
      missing: [],
    };
    const extensionEvaluations = evaluations.slice(1);
    const deliveryReady = runtime.hasDeliverableAttempt
      ? runtime.deliveryReady
      : extensionEvaluations.length > 0
        ? extensionEvaluations.some((evaluation) => evaluation.deliveryReady)
        : runtime.deliveryReady;
    const missing = deliveryReady
      ? []
      : [
          ...(runtime.missing ?? []),
          ...extensionEvaluations.flatMap((evaluation) => evaluation.missing ?? []),
        ];
    const evidence = evaluations.flatMap((evaluation) => evaluation.evidence);
    const evidenceKinds = [...new Set(evidence.map((item) => item.kind))];
    const verified = deliveryReady && missing.length === 0;
    const finalResponseReady = isFinalAgentResponse(input.proposedFinalText);
    return {
      verified,
      deliveryReady,
      finalResponseReady,
      phase: verified ? 'finalize' : 'verify',
      unresolvedTaskIds: [],
      missing,
      evidenceKinds,
    };
  }
}

const runtimeCompletionEvidenceProvider: CompletionEvidenceProvider = {
  id: 'runtime',
  evaluate(input) {
    const evidence = input.toolExecutions
      .filter((execution) => execution.status === 'success' && execution.completionEvidence)
      .map((execution) => execution.completionEvidence!);
    const attempts = input.toolExecutions.filter(
      (execution) =>
        execution.completionRole === 'deliverable' || execution.completionEvidence !== undefined,
    );
    const latest = attempts.at(-1);
    if (!latest) {
      return { evidence, deliveryReady: evidence.length === 0 || evidence.some(isReady) };
    }
    if (latest.status !== 'success') {
      const deliveredFailure =
        isFinalAgentResponse(input.proposedFinalText) &&
        isExplicitTerminalFailure(input.proposedFinalText);
      return {
        evidence,
        deliveryReady: deliveredFailure,
        hasDeliverableAttempt: true,
        ...(deliveredFailure
          ? {}
          : { missing: ['the latest deliverable action did not succeed'] }),
      };
    }
    if (!latest.completionEvidence) {
      return {
        evidence,
        deliveryReady: false,
        hasDeliverableAttempt: true,
        missing: ['completion evidence for the latest deliverable action'],
      };
    }
    if (
      (latest.completionEvidence.outcome === 'failed' ||
        latest.completionEvidence.outcome === 'cancelled') &&
      !(
        isFinalAgentResponse(input.proposedFinalText) &&
        isExplicitTerminalFailure(input.proposedFinalText)
      )
    ) {
      return {
        evidence,
        deliveryReady: false,
        hasDeliverableAttempt: true,
        missing: ['an explicit delivery of the terminal failure or cancellation'],
      };
    }
    return {
      evidence,
      deliveryReady: latest.completionEvidence.deliveryReady,
      hasDeliverableAttempt: true,
      ...(latest.completionEvidence.deliveryReady
        ? {}
        : { missing: ['a deliverable tool result or artifact'] }),
    };
  },
};

const PROCESS_ONLY_FINAL_PATTERNS = [
  /\b(?:let me|allow me|i(?:'ll| will))\b.{0,80}\b(?:verify|check|inspect|continue|confirm)\b/i,
  /\b(?:next|first)\s+(?:i(?:'ll| will)|step)\b.{0,80}\b(?:verify|check|inspect|continue)\b/i,
  /(?:让我|我来|接下来|下一步|稍后|将继续|正在).{0,40}(?:验证|核验|检查|确认|继续|查看)/,
  /(?:结果|数据|明细|表格|内容).{0,24}(?:如上|见上|上文|前文)|(?:如上|见上|上文|前文).{0,24}(?:结果|数据|表|所示|呈现)/,
  /\b(?:result|results|output|table|details?)\b.{0,60}\b(?:above|earlier|previously)\b/i,
  /\b(?:above|earlier|previously)\b.{0,60}\b(?:result|results|output|table|details?)\b/i,
];

const TERMINAL_FAILURE_FINAL_PATTERNS = [
  /(?:失败|错误|拒绝|未获批准|未批准|未执行|没有执行|超时|取消|无法|不能|只读)/,
  /\b(?:denied|rejected|failed|error|timeout|timed out|cancelled|canceled|unable|cannot|could not|read[- ]only)\b/i,
  /\bnot\s+(?:approved|executed|completed)\b/i,
];

export function isFinalAgentResponse(text: string): boolean {
  const normalized = text.trim();
  return Boolean(normalized) && !PROCESS_ONLY_FINAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isExplicitTerminalFailure(text: string): boolean {
  return TERMINAL_FAILURE_FINAL_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isReady(evidence: AgentToolCompletionEvidence): boolean {
  return evidence.deliveryReady;
}
