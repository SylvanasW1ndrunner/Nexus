import type {
  AgentPlan,
  AgentPlanExecuteResult,
  AgentPlanRecoveryPlan,
  AgentRunResult,
  PlanExecuteRecoveryService,
  ToolRegistry,
} from '@dbagent/core-agent';
import { findMatchingSkills, type SkillDefinition, type SkillMatchCandidate } from '@dbagent/core-skills';
import {
  NoMatchingSkillError,
  resolveOfficialPluginAgentTools,
  runAutoSkillAgent,
  type OfficialPluginAgentToolPolicy,
  type SkillAgent,
  type SkillPlanExecuteAgent,
} from '@dbagent/core-tools';
import type {
  AgentAbortRequest,
  AgentAbortResponse,
  AgentAbandonPlanRequest,
  AgentAbandonPlanResponse,
  AgentContinuePlanRequest,
  AgentContinuePlanResponse,
  AgentPlanRecoverySummary,
  AgentRecoverablePlansResponse,
  AgentRunPlanSummary,
  AgentRunStrategy,
  AgentRunRequest,
  AgentRunResponse,
  AgentSkillMatchCandidate,
  AgentSkillSummary,
  AgentToolPolicyPreview,
  AgentToolPolicyRequest,
  SkillsMatchRequest,
  SkillsMatchResponse,
} from '@dbagent/shared';

export type HeadlessAgentServiceDependencies = {
  agent: SkillAgent;
  planExecuteAgent?: SkillPlanExecuteAgent;
  planRecoveryService?: Pick<PlanExecuteRecoveryService, 'listRecoverablePlans' | 'continue' | 'abandon'>;
  toolRegistry: Pick<ToolRegistry, 'list'>;
  loadSkills: () => Promise<SkillDefinition[]> | SkillDefinition[];
  createRunId?: () => string;
  selectStrategy?: (request: AgentRunRequest) => Exclude<AgentRunStrategy, 'auto'>;
};

export class HeadlessAgentService {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly createRunId: () => string;

  constructor(private readonly dependencies: HeadlessAgentServiceDependencies) {
    this.createRunId = dependencies.createRunId ?? (() => crypto.randomUUID());
  }

  previewToolPolicy(request: AgentToolPolicyRequest): AgentToolPolicyPreview {
    return toSharedToolPolicy(this.resolveToolPolicy(request));
  }

  async matchSkills(request: SkillsMatchRequest): Promise<SkillsMatchResponse> {
    const toolPolicy = this.resolveToolPolicy(request);
    const candidates = findMatchingSkills(await this.dependencies.loadSkills(), {
      userInput: request.userInput,
      availableTools: toolPolicy.agentAllowedToolNames,
      includeIneligible: request.includeIneligible ?? true,
      ...(request.signals === undefined ? {} : { signals: request.signals }),
      ...(request.inferSignals === undefined ? {} : { inferSignals: request.inferSignals }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
      ...(request.minScore === undefined ? {} : { minScore: request.minScore }),
    });
    const sharedCandidates = candidates.map(toSharedCandidate);
    return {
      userInput: request.userInput,
      toolPolicy: toSharedToolPolicy(toolPolicy),
      candidates: sharedCandidates,
      ...(sharedCandidates.find((candidate) => candidate.eligible) === undefined
        ? {}
        : { selectedSkill: sharedCandidates.find((candidate) => candidate.eligible)! }),
    };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const runId = request.runId?.trim() || this.createRunId();
    const controller = new AbortController();
    const strategy = this.resolveStrategy(request);
    this.activeRuns.set(runId, controller);

    try {
      const skills = await this.dependencies.loadSkills();
      const autoSkillRunOptions = this.buildAutoSkillRunOptions(request, controller, skills);
      const output =
        strategy === 'plan-execute'
          ? await runAutoSkillAgent(this.requirePlanExecuteAgent(), {
              ...autoSkillRunOptions,
              strategy: 'plan-execute',
              ...(request.maxPlanSteps === undefined ? {} : { maxPlanSteps: request.maxPlanSteps }),
              ...(request.stopOnStepFailure === undefined ? {} : { stopOnStepFailure: request.stopOnStepFailure }),
            })
          : await runAutoSkillAgent(this.dependencies.agent, autoSkillRunOptions);

      return {
        runId,
        strategy,
        status: normalizeAgentStatus(output.result.status),
        ...sessionIdPart(output.result),
        finalText: output.result.finalText,
        iterations: resultIterations(output.result),
        ...planResultPart(output.result),
        toolExecutions: output.result.toolExecutions,
        toolPolicy: toSharedToolPolicy(output.toolPolicy),
        candidates: output.candidates.map(toSharedCandidate),
        selectedSkill: toSharedCandidate(output.autoPlan.candidate),
        renderedUserMessage: output.renderedUserMessage,
      };
    } catch (error) {
      if (error instanceof NoMatchingSkillError) {
        return {
          runId,
          strategy,
          status: 'no_matching_skill',
          finalText: 'No eligible Skill matched the user input and current tool policy.',
          iterations: 0,
          toolExecutions: [],
          toolPolicy: toSharedToolPolicy(this.resolveToolPolicy(request)),
          candidates: error.candidates.map(toSharedCandidate),
          errorMessage: error.message,
        };
      }
      if (controller.signal.aborted) {
        return {
          runId,
          strategy,
          status: 'aborted',
          finalText: 'Agent run was aborted.',
          iterations: 0,
          toolExecutions: [],
          toolPolicy: toSharedToolPolicy(this.resolveToolPolicy(request)),
          candidates: [],
        };
      }
      return {
        runId,
        strategy,
        status: 'failed',
        finalText: 'Agent run failed.',
        iterations: 0,
        toolExecutions: [],
        toolPolicy: toSharedToolPolicy(this.resolveToolPolicy(request)),
        candidates: [],
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async listRecoverablePlans(): Promise<AgentRecoverablePlansResponse> {
    return {
      plans: (await this.requirePlanRecoveryService().listRecoverablePlans()).map(toSharedRecoveryPlan),
    };
  }

  async continuePlan(request: AgentContinuePlanRequest): Promise<AgentContinuePlanResponse> {
    const runId = request.runId?.trim() || this.createRunId();
    const controller = new AbortController();
    const toolPolicy = this.resolveToolPolicy(request);
    this.activeRuns.set(runId, controller);

    try {
      const continued = await this.requirePlanRecoveryService().continue(request.planId, this.requirePlanExecuteAgent(), {
        providerId: request.providerId,
        model: request.model,
        ...(request.userMessage === undefined ? {} : { userMessage: request.userMessage }),
        allowedTools: toolPolicy.agentAllowedToolNames,
        ...(request.usageMode === undefined ? {} : { usageMode: request.usageMode }),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
        ...(request.maxPlanSteps === undefined ? {} : { maxPlanSteps: request.maxPlanSteps }),
        ...(request.stopOnStepFailure === undefined ? {} : { stopOnStepFailure: request.stopOnStepFailure }),
        ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }),
        ...(request.contextWindowTokens === undefined ? {} : { contextWindowTokens: request.contextWindowTokens }),
        ...(request.keepRecentMessages === undefined ? {} : { keepRecentMessages: request.keepRecentMessages }),
        ...(request.maxToolResultChars === undefined ? {} : { maxToolResultChars: request.maxToolResultChars }),
        ...(request.maxConsecutiveToolFailures === undefined
          ? {}
          : { maxConsecutiveToolFailures: request.maxConsecutiveToolFailures }),
        ...(request.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: request.maxToolExecutionMs }),
        signal: controller.signal,
      });

      return {
        runId,
        strategy: 'plan-execute',
        status: normalizeAgentStatus(continued.result.status),
        ...sessionIdPart(continued.result),
        finalText: continued.result.finalText,
        iterations: resultIterations(continued.result),
        ...planResultPart(continued.result),
        toolExecutions: continued.result.toolExecutions,
        toolPolicy: toSharedToolPolicy(toolPolicy),
        candidates: [],
        recoveryPlan: toSharedRecoveryPlan(continued.plan),
        abandonedSnapshot: continued.abandonedSnapshot,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          runId,
          strategy: 'plan-execute',
          status: 'aborted',
          finalText: 'Agent plan continuation was aborted.',
          iterations: 0,
          toolExecutions: [],
          toolPolicy: toSharedToolPolicy(toolPolicy),
          candidates: [],
          abandonedSnapshot: false,
        };
      }
      return {
        runId,
        strategy: 'plan-execute',
        status: 'failed',
        finalText: 'Agent plan continuation failed.',
        iterations: 0,
        toolExecutions: [],
        toolPolicy: toSharedToolPolicy(toolPolicy),
        candidates: [],
        abandonedSnapshot: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  abort(request: AgentAbortRequest): AgentAbortResponse {
    const controller = this.activeRuns.get(request.runId);
    if (!controller) {
      return {
        runId: request.runId,
        aborted: false,
        message: 'Agent run is not active.',
      };
    }
    controller.abort(new Error('Agent run aborted by user.'));
    return {
      runId: request.runId,
      aborted: true,
      message: 'Agent run abort signal sent.',
    };
  }

  async abandonPlan(request: AgentAbandonPlanRequest): Promise<AgentAbandonPlanResponse> {
    const abandoned = await this.requirePlanRecoveryService().abandon(request.planId, request.reason);
    return {
      planId: request.planId,
      abandoned,
      message: abandoned ? 'Recoverable Agent plan was abandoned.' : 'Recoverable Agent plan was not found.',
    };
  }

  private resolveToolPolicy(request: AgentToolPolicyRequest): OfficialPluginAgentToolPolicy {
    return resolveOfficialPluginAgentTools({
      toolRegistry: this.dependencies.toolRegistry,
      ...toToolPolicyOptions(request),
    });
  }

  private resolveStrategy(request: AgentRunRequest): Exclude<AgentRunStrategy, 'auto'> {
    if (request.strategy === 'react' || request.strategy === 'plan-execute') return request.strategy;
    return this.dependencies.selectStrategy?.(request) ?? selectDefaultAgentStrategy(request);
  }

  private requirePlanExecuteAgent(): SkillPlanExecuteAgent {
    if (!this.dependencies.planExecuteAgent) {
      throw new Error('Plan & Execute Agent is not configured for the desktop Agent service.');
    }
    return this.dependencies.planExecuteAgent;
  }

  private requirePlanRecoveryService(): Pick<PlanExecuteRecoveryService, 'listRecoverablePlans' | 'continue' | 'abandon'> {
    if (!this.dependencies.planRecoveryService) {
      throw new Error('Plan & Execute recovery service is not configured for the desktop Agent service.');
    }
    return this.dependencies.planRecoveryService;
  }

  private buildAutoSkillRunOptions(
    request: AgentRunRequest,
    controller: AbortController,
    skills: SkillDefinition[],
  ) {
    return {
      providerId: request.providerId,
      model: request.model,
      userInput: request.userInput,
      skills,
      toolPolicy: {
        toolRegistry: this.dependencies.toolRegistry,
        ...toToolPolicyOptions(request),
      },
      match: {
        ...(request.includeIneligible === undefined ? {} : { includeIneligible: request.includeIneligible }),
        ...(request.signals === undefined ? {} : { signals: request.signals }),
        ...(request.inferSignals === undefined ? {} : { inferSignals: request.inferSignals }),
        ...(request.maxResults === undefined ? {} : { diagnosticMaxResults: request.maxResults }),
        ...(request.minScore === undefined ? {} : { minScore: request.minScore }),
      },
      ...(request.userMessagePrefix === undefined ? {} : { userMessagePrefix: request.userMessagePrefix }),
      ...(request.usageMode === undefined ? {} : { usageMode: request.usageMode }),
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
      ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }),
      ...(request.contextWindowTokens === undefined ? {} : { contextWindowTokens: request.contextWindowTokens }),
      ...(request.keepRecentMessages === undefined ? {} : { keepRecentMessages: request.keepRecentMessages }),
      ...(request.maxToolResultChars === undefined ? {} : { maxToolResultChars: request.maxToolResultChars }),
      ...(request.maxConsecutiveToolFailures === undefined
        ? {}
        : { maxConsecutiveToolFailures: request.maxConsecutiveToolFailures }),
      ...(request.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: request.maxToolExecutionMs }),
      signal: controller.signal,
    };
  }
}

function toToolPolicyOptions(request: AgentToolPolicyRequest) {
  return {
    ...(request.enabledPluginIds === undefined ? {} : { enabledPluginIds: request.enabledPluginIds }),
    ...(request.disabledPluginIds === undefined ? {} : { disabledPluginIds: request.disabledPluginIds }),
    readonlyOnly: request.readonlyOnly ?? request.mode === 'readonly',
    ...(request.allowedPermissions === undefined ? {} : { allowedPermissions: request.allowedPermissions }),
    ...(request.maxDangerLevel === undefined ? {} : { maxDangerLevel: request.maxDangerLevel }),
  };
}

function toSharedToolPolicy(policy: OfficialPluginAgentToolPolicy): AgentToolPolicyPreview {
  return {
    allowedToolNames: policy.agentAllowedToolNames,
    blockedToolNames: policy.runtimeResolution.blockedToolNames,
    staticToolNames: policy.runtimeResolution.staticToolNames,
    dynamicToolNames: policy.runtimeResolution.dynamicToolNames,
    missingStaticToolNames: policy.runtimeResolution.missingStaticToolNames,
    toolPermissions: policy.toolPermissions.map((permission) => ({
      toolName: permission.toolName,
      pluginId: permission.pluginId,
      pluginName: permission.pluginName,
      contributionName: permission.contributionName,
      dynamic: permission.dynamic,
      dangerLevel: permission.dangerLevel,
      readonly: permission.readonly,
      runtime: permission.runtime,
      permissions: permission.permissions.map((item) => ({
        id: item.id,
        title: item.title,
        risk: item.risk,
        readonly: item.readonly,
        resourceScopes: [...item.resourceScopes],
        approvalPolicy: item.approvalPolicy,
        networkAccess: item.networkAccess,
        processAccess: item.processAccess,
        secretKinds: [...item.secretKinds],
        auditLevel: item.auditLevel,
      })),
    })),
  };
}

function toSharedCandidate(candidate: SkillMatchCandidate): AgentSkillMatchCandidate {
  return {
    skill: toSharedSkill(candidate.skill),
    score: candidate.score,
    reasons: candidate.reasons,
    matchedSignals: candidate.matchedSignals,
    availableTools: candidate.availableTools,
    missingTools: candidate.missingTools,
    eligible: candidate.eligible,
  };
}

function toSharedSkill(skill: SkillDefinition): AgentSkillSummary {
  return {
    name: skill.name,
    ...(skill.title === undefined ? {} : { title: skill.title }),
    description: skill.description,
    source: skill.source,
    ...(skill.sourcePath === undefined ? {} : { sourcePath: skill.sourcePath }),
    allowedTools: skill.allowedTools,
    outputFormat: skill.outputFormat,
  };
}

function selectDefaultAgentStrategy(request: AgentRunRequest): Exclude<AgentRunStrategy, 'auto'> {
  const text = request.userInput.trim().toLowerCase();
  const signals = new Set((request.signals ?? []).map((signal) => signal.trim().toLowerCase()));
  if (
    request.maxPlanSteps !== undefined ||
    signals.has('requires_multi_step_pipeline') ||
    signals.has('requires_modeling')
  ) {
    return 'plan-execute';
  }
  const planTerms = [
    'root cause',
    'why',
    'investigate',
    'step-by-step',
    'multi-step',
    'compare',
    'forecast',
    'model',
    '原因',
    '根因',
    '为什么',
    '分析',
    '排查',
    '步骤',
    '计划',
    '多步',
    '对比',
    '预测',
    '建模',
    '漏斗',
    '归因',
  ];
  return planTerms.some((term) => text.includes(term)) ? 'plan-execute' : 'react';
}

function normalizeAgentStatus(status: AgentRunResult['status'] | AgentPlanExecuteResult['status']): AgentRunResponse['status'] {
  return status === 'planning_failed' ? 'planning_failed' : status;
}

function sessionIdPart(result: AgentRunResult | AgentPlanExecuteResult): Pick<AgentRunResponse, 'sessionId'> {
  return result.session === undefined ? {} : { sessionId: result.session.id };
}

function resultIterations(result: AgentRunResult | AgentPlanExecuteResult): number {
  return 'iterations' in result ? result.iterations : result.totalIterations;
}

function planResultPart(
  result: AgentRunResult | AgentPlanExecuteResult,
): Pick<AgentRunResponse, 'executedSteps' | 'totalIterations' | 'plan'> {
  if (!('plan' in result)) return {};
  return {
    executedSteps: result.executedSteps,
    totalIterations: result.totalIterations,
    plan: toSharedPlan(result.plan),
  };
}

function toSharedPlan(plan: AgentPlan): AgentRunPlanSummary {
  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal,
    createdAt: plan.createdAt,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ...(step.resultSummary === undefined ? {} : { resultSummary: step.resultSummary }),
      ...(step.failureReason === undefined ? {} : { failureReason: step.failureReason }),
      ...(step.runStatus === undefined ? {} : { runStatus: step.runStatus }),
      ...(step.iterations === undefined ? {} : { iterations: step.iterations }),
    })),
  };
}

function toSharedRecoveryPlan(plan: AgentPlanRecoveryPlan): AgentPlanRecoverySummary {
  return {
    planId: plan.planId,
    ...(plan.sessionId === undefined ? {} : { sessionId: plan.sessionId }),
    title: plan.title,
    goal: plan.goal,
    ...(plan.interruptedStepId === undefined ? {} : { interruptedStepId: plan.interruptedStepId }),
    ...(plan.interruptedStepTitle === undefined ? {} : { interruptedStepTitle: plan.interruptedStepTitle }),
    completedStepCount: plan.completedStepCount,
    failedStepCount: plan.failedStepCount,
    skippedStepCount: plan.skippedStepCount,
    pendingStepCount: plan.pendingStepCount,
    executedSteps: plan.executedSteps,
    totalIterations: plan.totalIterations,
    startedAt: plan.startedAt,
    updatedAt: plan.updatedAt,
    ...(plan.lastResultText === undefined ? {} : { lastResultText: plan.lastResultText }),
    ...(plan.lastToolError === undefined ? {} : { lastToolError: plan.lastToolError }),
    resumePrompt: plan.resumePrompt,
    actions: plan.actions,
  };
}
