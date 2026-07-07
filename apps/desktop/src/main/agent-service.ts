import type { ToolRegistry } from '@dbagent/core-agent';
import { findMatchingSkills, type SkillDefinition, type SkillMatchCandidate } from '@dbagent/core-skills';
import {
  NoMatchingSkillError,
  resolveOfficialPluginAgentTools,
  runAutoSkillAgent,
  type OfficialPluginAgentToolPolicy,
  type SkillAgent,
} from '@dbagent/core-tools';
import type {
  AgentAbortRequest,
  AgentAbortResponse,
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
  toolRegistry: Pick<ToolRegistry, 'list'>;
  loadSkills: () => Promise<SkillDefinition[]> | SkillDefinition[];
  createRunId?: () => string;
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
    this.activeRuns.set(runId, controller);

    try {
      const output = await runAutoSkillAgent(this.dependencies.agent, {
        providerId: request.providerId,
        model: request.model,
        userInput: request.userInput,
        skills: await this.dependencies.loadSkills(),
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
      });

      return {
        runId,
        status: output.result.status,
        sessionId: output.result.session.id,
        finalText: output.result.finalText,
        iterations: output.result.iterations,
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

  private resolveToolPolicy(request: AgentToolPolicyRequest): OfficialPluginAgentToolPolicy {
    return resolveOfficialPluginAgentTools({
      toolRegistry: this.dependencies.toolRegistry,
      ...toToolPolicyOptions(request),
    });
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
