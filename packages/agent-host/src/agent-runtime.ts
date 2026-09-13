import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:process';
import {
  CapabilityControlPlane,
  AgentJournalError,
  JournalAgentSubagentRuntime,
  JournalAgentSubagentScheduler,
  JournalSessionStore,
  PermissionManager,
  ProjectArtifactStore,
  ProjectProbeChoiceAuthority,
  SessionModelBindingStore,
  SqliteAgentJournal,
  ToolRegistry,
  agentProjectStorageIdentity,
  agentProjectReference,
  createAgentProjectContext,
  createJournalAgentKernel,
  defaultAgentUserSkillsDirectory,
  describeRuntimeBinding,
  expectedToolError,
  projectTrustedRunUserActivity,
  replaceCapturedBaseToolInvocation,
  type AgentCapabilityModuleRegistration,
  type AgentCapabilityDiscoveryManifestEntry,
  type AgentCapabilityContextProviderContribution,
  type AgentMode,
  type AgentProjectContext,
  type AgentKernel,
  type JournalAgentTurnRuntimeLease,
  type AgentRunLimits,
  type DurableSubagentOutcomeRecovery,
  type UserActivityEvent,
  type ToolTargetRevalidator,
} from '@dbagent/core-agent';
import type { PromptSection } from '@dbagent/core-agent';
import {
  LlmConnectionManager,
  LlmProviderError,
  ModelExecutionGateway,
  type LlmAsyncJob,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmGenerationConfig,
  type LlmMetricsSnapshot,
  type LlmModelSelection,
} from '@dbagent/core-llm';
import {
  SkillRegistry,
  systemSkillSource,
  type SkillCatalogEntry,
  type SkillDirectorySource,
  type SkillOverlay,
} from '@dbagent/core-skills';
import {
  McpHealthManager,
  McpRuntimeManager,
  McpToolRegistrationManager,
  CapabilityCommandRuntime,
  NodeSecureWebTransport,
  PathExecutableDiscovery,
  ProcessRuntime,
  compileProjectContext,
  createAskUserToolContribution,
  createMcpRuntimeLauncher,
  createNodeWorkspaceMutationPrimitive,
  createNoReplaceWorkspaceMutationAdapter,
  createProcessTargetRevalidator,
  createProcessToolContributions,
  createResultMaterializeToolContribution,
  createResultReadToolContribution,
  createResultSaveTargetRevalidator,
  createResultSaveToolContribution,
  createSkillToolContribution,
  createTaskPlanTargetRevalidator,
  createTaskToolContributions,
  createSubagentToolContributions,
  createToolSearchToolContribution,
  createWebToolGeneration,
  createWorkspaceToolGeneration,
  ResultMaterializationStore,
  type McpServerConfig,
  type McpServerHealthState,
  type McpServerInput,
  type WebToolGeneration,
  type WorkspaceMutationAdapter,
  type WorkspaceToolGeneration,
} from '@dbagent/core-tools';
import { UsageTracker } from '@dbagent/core-usage';
import type { PortableValue, UsageMode } from '@dbagent/shared';
import { AgentRuntimeError } from './errors.js';
import { registerAgentRuntimeHostServices } from './internal/agent-runtime-host-services.js';
import type {
  AgentApprovalDecision,
  AgentOutcomeResolution,
  AgentPendingQuestion,
  AgentQuestionAnswerInput,
  AgentQuestionCancelInput,
  AgentRiskyRetryAuthorization,
  AgentRunEventOptions,
  AgentRunHandle,
  AgentRunResult as DurableAgentRunResult,
  AgentSteeringInput,
  AgentRuntimeOptions,
  AgentSystemPrompt,
  AgentRuntimeStatus,
  AgentSessionListInput,
  AgentSessionListPage,
  AgentSessionView,
  ConfigureSessionSkillsInput,
  AgentSkillCatalogEntry,
  AgentSkillInspection,
  AgentToolSummary,
  AgentUsageProjectionStatus,
  AgentUsageSnapshot,
  AgentSkillListInput,
  AgentSkillRefreshResult,
  DiscoverLlmConnectionInput,
  DiscoverLlmConnectionResult,
  LlmRuntimeCallOptions,
  LlmRuntimeBatchItem,
  LlmRuntimeBatchOptions,
  LlmRuntimeChatRequest,
  LlmConnectionSummary,
  ListLlmModelsInput,
  ListLlmModelsResult,
  McpServerStartSummary,
  McpServerStopSummary,
  McpServerSummary,
  GlobalConfigView,
  ProjectSettingsView,
  AgentRunInput,
  AgentRunResultOptions,
  SelectSessionModelInput,
  SessionLlmConfiguration,
  SetSessionParametersInput,
} from './types.js';
import { ProjectSettingsStore } from './project-settings.js';
import {
  GlobalConfigStore,
  type GlobalConfigSnapshot,
  type GlobalSecretResolver,
} from './global-config.js';
import { ProjectMcpConfigStore } from './project-mcp-config-store.js';
import {
  DirectLlmRuntime,
  type DirectLlmExecutionResult,
} from './direct-llm-runtime.js';

const MAX_MESSAGE_CHARS = 100_000;
const MAX_IDENTIFIER_CHARS = 300;
const MAX_INITIAL_SYSTEM_SKILLS = 12;
const MAX_INITIAL_SYSTEM_SKILL_CATALOG_CHARS = 3_000;
/** Host contribution bounds, independent of model/user context budgets. */
const CONTEXT_PROVIDER_HOST_TOKEN_BUDGET = 2_048;
const CONTEXT_PROVIDER_HOST_DEADLINE_MS = 5_000;
const INITIALIZATION_CLOSE_DEADLINE_MS = 5_000;

type DurableRunConfiguration = Readonly<{
  rolePrompt?: DurableRolePromptConfiguration;
  capabilityInstructions: readonly string[];
  allowedTools?: readonly string[];
}>;

type DurableRolePrompt = Readonly<{
  mode: 'append' | 'replace';
  content: string;
}>;

type DurableRolePromptConfiguration = Readonly<{
  default?: DurableRolePrompt;
  run?: DurableRolePrompt;
}>;

type NewRunModelConfiguration = Readonly<{
  requestParameters?: LlmGenerationConfig;
  signal?: AbortSignal;
}>;

type PreparedAgentRuntimeOptions = Readonly<{
  newSessionModel: LlmModelSelection | undefined;
  defaultSessionSkills: SkillOverlay[];
  defaultSystemPrompt: AgentSystemPrompt | undefined;
  defaultCapabilityInstructions: string[];
  defaultAllowedTools: string[] | undefined;
  webAdapter: AgentRuntimeOptions['webAdapter'];
  interactive: boolean;
}>;

/**
 * Generic Agent composition root. It owns the Agent kernel and host
 * primitives, while professional behavior enters through Capability modules.
 */
export class AgentRuntime {
  private readonly tools: ToolRegistry;
  private readonly capabilities: CapabilityControlPlane;
  private readonly skills: SkillRegistry;
  private readonly sessions: JournalSessionStore;
  private readonly mcpConfig: ProjectMcpConfigStore;
  private readonly mcp: McpRuntimeManager;
  private readonly processes: ProcessRuntime;
  private readonly artifacts: ProjectArtifactStore;
  private readonly resultMaterializations: ResultMaterializationStore;
  private readonly workspaceMutationAdapter: WorkspaceMutationAdapter;
  private readonly probeChoices: ProjectProbeChoiceAuthority;
  private readonly workspaceTools: WorkspaceToolGeneration;
  private readonly webTools: WebToolGeneration;
  private readonly revalidateToolTarget: ToolTargetRevalidator;
  private readonly project: AgentProjectContext;
  private readonly usageTracker: UsageTracker;
  private readonly llmConnections: LlmConnectionManager;
  private readonly settings: ProjectSettingsStore;
  private readonly globalConfig: GlobalConfigStore;
  private readonly globalSecretResolver: GlobalSecretResolver | undefined;
  readonly tenantId: string;
  private readonly directLlm: DirectLlmRuntime;

  private readonly defaultSessionSkills: SkillOverlay[];
  private skillsReady: Promise<unknown>;
  private skillInitializationError: Error | undefined;
  private readonly baseSkillSources: SkillDirectorySource[];
  /** Last capability Skill-source generation which completed a refresh. */
  private committedCapabilitySkillSourceSignature = '';
  /** Serializes shared SkillRegistry source transitions across Run captures. */
  private capabilitySkillSourceSync: Promise<void> = Promise.resolve();
  /**
   * One publication boundary for Capability generations and their shared Skill
   * source view. A Turn captures both immutable views while holding this gate;
   * slow Skill document loading and Context Providers deliberately happen after
   * the gate is released.
   */
  private capabilitySkillCriticalSection: Promise<void> = Promise.resolve();
  /** Module registration is metadata-only and closes once the first Turn snapshot is captured. */
  private capabilityRegistrationClosed = false;
  private readonly contextProviderDiagnostics = new Map<string, string>();
  /** Test-only host override; never part of the public Runtime options type. */
  private readonly contextProviderHostDeadlineMs: number;
  /** Test-only bound for injected initialization work which ignores shutdown. */
  private readonly initializationCloseDeadlineMs: number;
  private readonly defaultSystemPrompt: AgentRuntimeOptions['systemPrompt'];
  private readonly defaultCapabilityInstructions: string[];
  private readonly defaultAllowedTools: string[] | undefined;
  private readonly autoStartMcp: boolean;
  private mcpAutoStartPromise: Promise<unknown> | undefined;
  /** Cancels a multi-server startup sequence before it can admit the next server. */
  private readonly mcpStartupSequenceController = new AbortController();
  private readonly ownsLlmConnections: boolean;
  private readonly globalConfigReady: Promise<void>;
  private resultMaterializationsReady: Promise<void> = Promise.resolve();
  private resultMaterializationInitializationError: Error | undefined;
  private globalConfigInitializationError: Error | undefined;
  private globalConfigSnapshot: GlobalConfigSnapshot | undefined;
  private targetGlobalConfigRevision = 'global-config:unloaded';
  private currentGlobalConfigRevision = 'global-config:unloaded';
  private readonly livePermissionManager = new PermissionManager({
    revision: 'global-config:unloaded',
  });
  private globalConfigApplyTail: Promise<void> = Promise.resolve();
  private stopGlobalConfigWatcher: (() => void) | undefined;
  private readonly newSessionModel: LlmModelSelection | undefined;
  private readonly journal: SqliteAgentJournal;
  /** Detaches this Runtime's reader; a shared Tracker deduplicates this authority by source key. */
  private readonly releaseUsageProjection: () => void;
  private readonly modelBindings: SessionModelBindingStore;
  private readonly modelGateway = new ModelExecutionGateway();
  private readonly projectId: string;
  private readonly kernels = new Map<string, AgentKernel>();
  private readonly handles = new Map<string, AgentRunHandle>();
  private readonly starts = new Map<string, Promise<AgentRunHandle>>();
  private readonly drivers = new Map<string, Promise<void>>();
  private readonly driverWakeRequests = new Set<string>();
  private readonly questionDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly questionDeadlineGenerations = new Map<string, object>();
  private readonly questionSettlements = new Set<Promise<void>>();
  /**
   * Close-owned parent shutdown operations. Starting one first releases the
   * active executor lease, fencing any in-flight Model/Tool callback before
   * the replacement writer persists the shutdown interruption.
   */
  private readonly parentShutdowns = new Map<string, Promise<void>>();
  /** Live child Runs are exclusively advanced by the subagent scheduler. */
  private readonly childDriverKernels = new Map<string, Readonly<{
    sessionId: string;
    kernel: AgentKernel;
  }>>();
  /** Serializes child ownership admission across child-first/concurrent opens. */
  private readonly childKernelInitializations = new Map<string, Readonly<{
    sessionId: string;
    operation: Promise<AgentKernel>;
  }>>();
  private readonly terminalWaiters = new Map<string, Array<{
    resolve(value: DurableAgentRunResult): void;
    reject(reason: unknown): void;
  }>>();
  private readonly ownedToolCatalogs = new Set<ReturnType<ToolRegistry['captureSnapshot']>>();
  /** The sole owner of retained background child Run advancement. */
  private readonly subagentScheduler: JournalAgentSubagentScheduler;
  private readonly kernelCatalogs = new WeakMap<AgentKernel, ReturnType<ToolRegistry['captureSnapshot']>>();
  private readonly kernelDependencyReleases = new WeakMap<AgentKernel, Array<() => void>>();
  private closing = false;
  private closed = false;
  private closeOperation: Promise<void> | undefined;
  private usageProjectionReleased = false;

  constructor(options: AgentRuntimeOptions = {}) {
    const preparedOptions = prevalidateAgentRuntimeOptions(options);
    this.contextProviderHostDeadlineMs = internalContextProviderDeadline(options);
    this.initializationCloseDeadlineMs = internalInitializationCloseDeadline(options);
    this.usageTracker = options.usageTracker ?? new UsageTracker();
    this.tenantId = options.tenantId?.trim() || 'local-default';
    this.project = createAgentProjectContext(resolve(options.projectDirectory ?? process.cwd()));
    this.settings = options.settingsStore ?? new ProjectSettingsStore(this.project.rootPath);
    this.globalConfig = options.globalConfigStore ?? new GlobalConfigStore();
    this.globalSecretResolver = options.globalSecretResolver;
    this.ownsLlmConnections = options.llmManager === undefined;
    this.llmConnections =
      options.llmManager ??
      new LlmConnectionManager({
        cacheDirectory: join(dirname(this.globalConfig.path), 'cache', 'llm-models'),
      });
    this.directLlm = new DirectLlmRuntime({
      manager: this.llmConnections,
      usageTracker: this.usageTracker,
      tenantId: this.tenantId,
    });
    this.newSessionModel = preparedOptions.newSessionModel;
    this.tools = new ToolRegistry();
    this.capabilities = new CapabilityControlPlane({ toolRegistry: this.tools });
    for (const registration of options.modules ?? []) this.capabilities.register(registration);

    const stateDatabasePath =
      options.stateDatabasePath ?? join(this.project.configDirectory, 'state.db');
    this.projectId = agentProjectStorageIdentity(agentProjectReference(this.project)).projectKey;
    this.journal = new SqliteAgentJournal({ filePath: stateDatabasePath });
    this.artifacts = new ProjectArtifactStore({
      projectId: this.projectId,
      rootDir: join(this.project.configDirectory, 'runtime', 'artifacts'),
      journal: this.journal,
    });
    this.resultMaterializations = new ResultMaterializationStore({
      projectRoot: this.project.rootPath,
      rootDirectory: join(this.project.configDirectory, 'runtime', 'materialized'),
    });
    this.probeChoices = new ProjectProbeChoiceAuthority(
      join(this.project.configDirectory, 'runtime', 'probe-choice.key'),
    );
    this.releaseUsageProjection = this.usageTracker.attachAbsoluteProjection({
      sourceKey: `agent-journal:${canonicalUsageDatabasePath(stateDatabasePath)}:${this.projectId}`,
      getSnapshot: async () => (await this.journal.getProjectUsageTotals(this.projectId)).map(
        ({ billingMode, windowStartedAt, inputTokens, outputTokens, totalTokens }) => ({
          mode: billingMode,
          windowStartedAt,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens,
        }),
      ),
    });
    this.subagentScheduler = new JournalAgentSubagentScheduler({
      journal: this.journal,
      resolveKernel: async (runId) => {
        const run = await this.journal.getRunProjection(runId);
        if (run === null || run.projectId !== this.projectId) {
          throw new AgentRuntimeError('RUN_NOT_FOUND', 'Child Agent Run was not found.', false);
        }
        return await this.kernelForChild(runId, run.sessionId);
      },
      ...(options.subagentScheduler?.maxConcurrentChildren === undefined
        ? {}
        : { maxConcurrentChildren: options.subagentScheduler.maxConcurrentChildren }),
      ...(options.subagentScheduler?.maxTurnsPerChild === undefined
        ? {}
        : { maxTurnsPerChild: options.subagentScheduler.maxTurnsPerChild }),
      ...(options.subagentScheduler?.maxDepth === undefined
        ? {}
        : { maxDepth: options.subagentScheduler.maxDepth }),
      ...(options.subagentScheduler?.maxChildrenPerRoot === undefined
        ? {}
        : { maxChildrenPerRoot: options.subagentScheduler.maxChildrenPerRoot }),
    });
    this.modelBindings = new SessionModelBindingStore(this.journal);
    this.sessions = new JournalSessionStore(this.journal, this.projectId);
    this.defaultSessionSkills = preparedOptions.defaultSessionSkills;
    this.baseSkillSources = [
      systemSkillSource(),
      {
        scope: 'user',
        path: options.userSkillsDirectory ?? defaultAgentUserSkillsDirectory(),
        id: 'schemanaut-user',
      },
      { scope: 'project', path: this.project.skillsDirectory, id: 'schemanaut-project' },
    ];
    this.skills = new SkillRegistry({
      sources: this.baseSkillSources,
      revisionCachePath: join(this.project.configDirectory, 'cache', 'skills'),
      capabilityResolver: (requirements) =>
        this.capabilities.satisfies(requirements, { activeOnly: true }),
    });
    this.skillsReady = Promise.resolve();

    this.defaultSystemPrompt = preparedOptions.defaultSystemPrompt;
    this.defaultCapabilityInstructions = preparedOptions.defaultCapabilityInstructions;
    this.defaultAllowedTools = preparedOptions.defaultAllowedTools;

    this.processes = options.processRuntime ?? new ProcessRuntime({
      spoolDirectory: join(this.project.configDirectory, 'runtime', 'processes'),
    });
    registerAgentRuntimeHostServices(this, {
      project: Object.freeze({
        rootPath: this.project.rootPath,
        configDirectory: this.project.configDirectory,
        projectId: agentProjectStorageIdentity(agentProjectReference(this.project)).projectKey,
        tenantId: this.tenantId,
      }),
      embed: (input) => this.llmConnections.embed(input),
      rerank: (input) => this.llmConnections.rerank(input),
      command: new CapabilityCommandRuntime(this.processes),
      executables: new PathExecutableDiscovery(),
    });
    this.workspaceMutationAdapter = createNoReplaceWorkspaceMutationAdapter(
      createNodeWorkspaceMutationPrimitive(),
    );
    this.workspaceTools = createWorkspaceToolGeneration({
      rootPath: this.project.rootPath,
      mutationAdapter: this.workspaceMutationAdapter,
    });
    this.webTools = createWebToolGeneration({
      transport: new NodeSecureWebTransport(),
      ...(preparedOptions.webAdapter === undefined
        ? {}
        : { searchAdapter: preparedOptions.webAdapter }),
    });
    const taskTargetRevalidator = createTaskPlanTargetRevalidator();
    const processTargetRevalidator = createProcessTargetRevalidator(this.processes);
    this.revalidateToolTarget = composeToolTargetRevalidators([
      taskTargetRevalidator,
      this.workspaceTools.revalidateTarget,
      createResultSaveTargetRevalidator(this.workspaceMutationAdapter),
      processTargetRevalidator,
      this.webTools.revalidateTarget,
    ]);
    const processTools = createProcessToolContributions({
      rootPath: this.project.rootPath,
      runtime: this.processes,
    });
    const capabilityActivatorRevision = 'capability-control-plane.activation.v1';
    this.tools.publishBaselineInvocations([
      createAskUserToolContribution({ interactive: preparedOptions.interactive }),
      createToolSearchToolContribution({
        capabilityActivator: {
          revision: capabilityActivatorRevision,
          activate: async ({
            target, probeChoiceRef, hostId, projectId, sessionId, runId, signal, deadline,
          }) => {
            try {
              if (signal.aborted || Date.now() >= Date.parse(deadline)) {
                throw new Error('Capability probe was cancelled or expired.');
              }
              const availability = await this.capabilities.probe(target, { signal, deadline });
              if (availability.status === 'available' || availability.status === 'degraded') {
                if (availability.activation === undefined) {
                  if (probeChoiceRef !== undefined) {
                    return {
                      status: 'denied',
                      reason: 'This Capability does not accept an external context choice.',
                    };
                  }
                  return { status: 'activated' };
                }
                if (availability.activation.selection === 'automatic') {
                  if (probeChoiceRef !== undefined) {
                    return {
                      status: 'denied',
                      reason: 'This Capability selects its only external context automatically.',
                    };
                  }
                  const candidate = availability.activation.candidates[0]!;
                  const binding = this.capabilities.bindProbeChoice({
                    ...target,
                    providerId: availability.activation.providerId,
                    candidateId: candidate.candidateId,
                    probeRevision: availability.activation.probeRevision,
                  });
                  return { status: 'activated', binding };
                }
                if (probeChoiceRef === undefined) {
                  return {
                    status: 'denied',
                    reason: 'This Capability requires one of the probed external contexts.',
                  };
                }
                const choice = await this.probeChoices.verify(probeChoiceRef, {
                  hostId, projectId, sessionId, runId,
                });
                const binding = this.capabilities.bindProbeChoice({
                  ...target,
                  providerId: choice.providerId,
                  candidateId: choice.candidateId,
                  probeRevision: choice.probeRevision,
                });
                return { status: 'activated', binding };
              }
              return {
                status: 'unavailable',
                reason: availability.reason ?? `Capability is ${availability.status}.`,
              };
            } catch (error) {
              const expected = expectedCapabilityActivationError(error);
              return {
                status: 'unavailable',
                reason: expected?.message ?? 'Capability activation failed; inspect its external prerequisite and retry.',
              };
            }
          },
        },
      }),
      createResultReadToolContribution({ artifactStore: this.artifacts }),
      createResultMaterializeToolContribution({
        artifactStore: this.artifacts,
        materializationStore: this.resultMaterializations,
      }),
      createResultSaveToolContribution({
        rootPath: this.project.rootPath,
        artifactStore: this.artifacts,
        mutationAdapter: this.workspaceMutationAdapter,
      }),
      createSkillToolContribution(this.skills),
      ...this.workspaceTools.contributions,
      ...processTools,
      ...this.webTools.contributions,
    ]);
    for (const contribution of [
      ...createTaskToolContributions(),
      ...createSubagentToolContributions(),
    ]) {
      this.tools.registerInvocation(contribution.definition, contribution.runtime);
    }
    this.mcpConfig = new ProjectMcpConfigStore(this.settings);
    this.mcp = new McpRuntimeManager({
      configStore: this.mcpConfig,
      health: new McpHealthManager(),
      tools: new McpToolRegistrationManager(this.tools),
      onGenerationPublished: async ({ event, commit, rollback }) => {
        await this.withCapabilitySkillCriticalSection(async () => {
          const providerId = `mcp:${event.serverId}`;
          if (event.status === 'stopped') {
            await this.capabilities.publishExternalProviderGeneration({
              removeProviderId: providerId,
              commit,
              rollback: rollback ?? (() => undefined),
            });
            return;
          }
          await this.capabilities.publishExternalProviderGeneration({
            provider: {
              providerId,
              description: 'Tools supplied by a configured MCP server.',
              capabilities: [
                {
                  id: 'mcp.tools',
                  description: 'Invoke tools supplied through the Model Context Protocol.',
                },
              ],
              status:
                event.status === 'ready'
                  ? 'available'
                  : event.status === 'disabled'
                    ? 'disabled'
                    : 'unavailable',
              active: event.status === 'ready',
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            },
            commit,
            rollback: rollback ?? (() => undefined),
          });
        });
      },
      launcher: createMcpRuntimeLauncher({
        cwd: this.project.rootPath,
        ...(options.mcpSecretResolver === undefined
          ? {}
          : { resolveSecret: options.mcpSecretResolver }),
      }),
    });
    this.autoStartMcp = options.autoStartMcp ?? false;

    // Do not start configuration loading or file watching until every synchronous
    // public constructor validation and registration has completed. This
    // keeps a failed synchronous constructor free of background work.
    const initialCapabilitySkillSourceSignature = JSON.stringify(this.capabilities.skillSources());
    this.skillsReady = this.observeSkillRefresh(this.skills.refresh()).then(() => {
      if (this.skillInitializationError === undefined) {
        this.committedCapabilitySkillSourceSignature = initialCapabilitySkillSourceSignature;
      }
    });
    this.globalConfigReady = this.initializeGlobalConfig().catch((error: unknown) => {
      this.globalConfigInitializationError =
        error instanceof Error ? error : new Error(String(error));
    });
    this.resultMaterializationsReady = this.initializeResultMaterializations().catch(
      (error: unknown) => {
        this.resultMaterializationInitializationError =
          error instanceof Error ? error : new Error(String(error));
      },
    );

  }

  registerModule(registration: AgentCapabilityModuleRegistration): void {
    this.assertRunning();
    if (this.capabilityRegistrationClosed) {
      throw new AgentRuntimeError(
        'RUN_STATE_INVALID',
        'Capability modules must be registered before the first Agent Turn is captured.',
        false,
      );
    }
    this.capabilities.register(registration);
  }

  async activateModule(moduleId: string, instanceId: string): Promise<void> {
    this.assertRunning();
    await this.withCapabilitySkillCriticalSection(async () => {
      await this.capabilities.activate({ moduleId, instanceId });
      await this.syncCapabilitySkillSources();
    });
  }

  async refreshModule(
    moduleId: string,
    instanceId: string,
    options: Readonly<{ deferRetirement?: boolean }> = {},
  ): Promise<void> {
    this.assertRunning();
    await this.withCapabilitySkillCriticalSection(async () => {
      await this.capabilities.refresh({
        moduleId,
        instanceId,
        ...(options.deferRetirement === true ? { retirement: 'defer' as const } : {}),
      });
      await this.syncCapabilitySkillSources();
    });
  }

  async deactivateModule(moduleId: string, instanceId: string): Promise<void> {
    this.assertRunning();
    await this.withCapabilitySkillCriticalSection(async () => {
      await this.capabilities.deactivate({ moduleId, instanceId });
      await this.syncCapabilitySkillSources();
    });
  }

  status(): AgentRuntimeStatus {
    const connections = this.llmConnections.connections().map((connection) => ({
      id: connection.id,
      name: connection.name,
      endpoint: connection.endpoint,
    }));
    return {
      providerConfigured: connections.length > 0,
      llm: {
        modelCount: this.llmConnections.models().length,
        metrics: this.directLlm.metrics(),
      },
      capabilities: this.capabilities.snapshot(),
      connections,
      contextProviderDiagnostics: [...this.contextProviderDiagnostics.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, message]) => ({ id, message })),
      globalConfigSynchronization: {
        targetRevision: this.targetGlobalConfigRevision,
        appliedRevision: this.currentGlobalConfigRevision,
        synchronized:
          this.targetGlobalConfigRevision === this.currentGlobalConfigRevision &&
          this.globalConfigInitializationError === undefined,
        ...(this.globalConfigInitializationError === undefined
          ? {}
          : { error: 'Global configuration could not be fully applied.' as const }),
      },
    };
  }

  async usage(mode?: UsageMode): Promise<AgentUsageSnapshot> {
    return await this.usageTracker.current(mode);
  }

  async usageByMode(): Promise<readonly AgentUsageSnapshot[]> {
    return await this.usageTracker.currentAll();
  }

  async usageProjectionStatus(): Promise<readonly AgentUsageProjectionStatus[]> {
    return await this.usageTracker.projectionStatus();
  }

  listAgentTools(): AgentToolSummary[] {
    return this.tools.listDescriptors().map((tool) => ({
      name: tool.flatName,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      source: tool.source,
      readonly: tool.readonly,
      dangerLevel: tool.dangerLevel,
      exposure: tool.exposure,
    }));
  }

  async ready(): Promise<void> {
    this.assertRunning();
    await Promise.all([
      this.globalConfigReady,
      this.skillsReady,
      this.resultMaterializationsReady,
    ]);
    this.assertRunning();
    if (this.globalConfigInitializationError !== undefined) {
      throw this.globalConfigInitializationError;
    }
    if (this.skillInitializationError !== undefined) throw this.skillInitializationError;
    if (this.resultMaterializationInitializationError !== undefined) {
      throw this.resultMaterializationInitializationError;
    }
    await this.ensureMcpAutoStarted();
  }

  async getGlobalConfig(): Promise<GlobalConfigView> {
    await this.globalConfigReady;
    if (this.globalConfigInitializationError !== undefined) {
      throw this.globalConfigInitializationError;
    }
    const snapshot = this.requireGlobalConfigSnapshot();
    return {
      path: snapshot.path,
      revision: snapshot.revision,
      exists: snapshot.exists,
      connections: this.listLlmConnections(),
      parameters: structuredClone(snapshot.settings.models.parameters),
      permissionMode: snapshot.settings.agent.permission_mode,
      requireSandbox: snapshot.settings.agent.require_sandbox,
      permissionRules: structuredClone(snapshot.settings.permissions.rules),
    };
  }

  /** Location of the global, externally authored model and enterprise policy document. */
  globalConfigPath(): string {
    return this.globalConfig.path;
  }

  /** Location of the project-owned MCP settings document for host UX. */
  projectSettingsPath(): string {
    return this.settings.settingsPath;
  }

  /** Reloads and validates the project-local MCP settings document. */
  async reloadProjectSettings(): Promise<ProjectSettingsView> {
    this.assertRunning();
    const snapshot = await this.settings.load();
    return {
      path: snapshot.path,
      revision: snapshot.revision,
      exists: snapshot.exists,
      mcpServerCount: Object.keys(snapshot.settings.mcp?.servers ?? {}).length,
    };
  }

  /** Previews the effective model configuration before a Session exists. */
  async previewModelParameters(model: LlmModelSelection): Promise<SessionLlmConfiguration> {
    await this.globalConfigReady;
    const prepared = await this.llmConnections.prepare(model);
    return {
      model: { ...model },
      effectiveParameters: this.llmConnections.effectiveParameters(model),
      contextTokens: prepared.model.contextTokens,
      maxInputTokens: prepared.model.maxInputTokens,
      maxOutputTokens: prepared.model.maxOutputTokens,
    };
  }

  /** Reloads the externally edited global config before discovery or diagnosis. */
  async reloadGlobalConfig(): Promise<GlobalConfigView> {
    this.assertRunning();
    await this.globalConfigReady;
    const snapshot = await this.globalConfig.reload();
    this.assertRunning();
    await this.applyGlobalConfigSnapshot(snapshot);
    await this.ensureGlobalConfigWatcher();
    return await this.getGlobalConfig();
  }

  async discoverLlmConnection(
    input: DiscoverLlmConnectionInput,
  ): Promise<DiscoverLlmConnectionResult> {
    await this.globalConfigReady;
    return await this.llmConnections.discover(
      requireText(input.connectionId, 'connectionId', MAX_IDENTIFIER_CHARS),
      {
        ...(input.inspectModelIds === undefined
          ? {}
          : {
              inspectModelIds: input.inspectModelIds.map((model) =>
                requireText(model, 'inspectModelIds[]', MAX_IDENTIFIER_CHARS),
              ),
            }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }

  listLlmConnections(): LlmConnectionSummary[] {
    return this.llmConnections.connections().map((connection) => ({
      id: connection.id,
      name: connection.name,
      endpoint: connection.endpoint,
      hasApiKey: connection.apiKey !== undefined,
      headerNames: Object.keys(connection.headers).sort(),
    }));
  }

  listLlmModels(input: ListLlmModelsInput = {}): ListLlmModelsResult {
    return this.llmConnections.models(input);
  }

  async selectSessionModel(input: SelectSessionModelInput): Promise<AgentSessionView> {
    this.assertRunning();
    await this.globalConfigReady;
    const sessionId = requireText(input.sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const session = await this.sessions.get(sessionId);
    if (session === null) {
      throw new AgentRuntimeError('INVALID_INPUT', `Session was not found: ${sessionId}`, false);
    }
    this.assertExternallyAddressableSession(sessionId, session);
    const model = normalizeModelSelection(input.model);
    await this.llmConnections.prepare(model);
    const effective = this.llmConnections.effectiveParameters(model, {
      ...(input.parameters === undefined ? {} : { session: input.parameters }),
    });
    const prepared = await this.llmConnections.prepareModelSessionBundle(model, {
      generation: effective.values,
    });
    const current = await this.modelBindings.get(this.projectId, sessionId);
    await this.modelBindings.bind({
      projectId: this.projectId,
      sessionId,
      commandId: `select-model:${randomUUID()}`,
      expectedRevision: current?.revision ?? 0,
      session: prepared,
    });
    return (await this.getAgentSession(sessionId))!;
  }

  async setSessionParameters(input: SetSessionParametersInput): Promise<AgentSessionView> {
    this.assertRunning();
    const sessionId = requireText(input.sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const session = await this.sessions.get(sessionId);
    if (session === null) {
      throw new AgentRuntimeError('INVALID_INPUT', `Session was not found: ${sessionId}`, false);
    }
    this.assertExternallyAddressableSession(sessionId, session);
    if (session.modelBinding === undefined) {
      throw new AgentRuntimeError(
        'NOT_CONFIGURED',
        `Session ${sessionId} does not have a selected model.`,
        true,
      );
    }
    return await this.selectSessionModel({
      sessionId,
      model: {
        connectionId: session.modelBinding.connectionId,
        modelId: session.modelBinding.modelId,
      },
      parameters: structuredClone(input.parameters),
    });
  }

  async effectiveSessionParameters(sessionId: string): Promise<SessionLlmConfiguration> {
    await this.globalConfigReady;
    const normalizedId = requireText(sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const session = await this.sessions.get(normalizedId);
    if (session?.modelBinding === undefined) {
      throw new AgentRuntimeError(
        'NOT_CONFIGURED',
        `Session ${normalizedId} does not have a selected model.`,
        true,
      );
    }
    const model = {
      connectionId: session.modelBinding.connectionId,
      modelId: session.modelBinding.modelId,
    };
    const prepared = await this.llmConnections.prepare(model);
    return {
      model,
      effectiveParameters: this.llmConnections.effectiveParameters(model, {
        session: session.modelBinding.parameters,
      }),
      contextTokens: prepared.model.contextTokens,
      maxInputTokens: prepared.model.maxInputTokens,
      maxOutputTokens: prepared.model.maxOutputTokens,
    };
  }

  /** Starts one durable Journal-backed Run and returns before Model execution completes. */
  startAgentRun(input: AgentRunInput): Promise<AgentRunHandle> {
    this.assertRunning();
    assertNoRunPermissionOverride(input);
    const requestId = input.clientRequestId?.trim() || randomUUID();
    const sessionId = input.sessionId?.trim() || (
      input.clientRequestId?.trim()
        ? deterministicSessionId(this.projectId, requestId)
        : randomUUID()
    );
    const key = `${sessionId}\u0000${requestId}`;
    const active = this.starts.get(key);
    if (active !== undefined) return active;
    const operation = this.startDurableRun(input, sessionId, requestId);
    this.starts.set(key, operation);
    return operation.finally(() => {
      if (this.starts.get(key) === operation) this.starts.delete(key);
    });
  }

  /** Reopens a durable Run without creating a second execution path. */
  async openAgentRun(runId: string): Promise<AgentRunHandle> {
    this.assertRunning();
    await this.ensureGlobalConfigReady();
    const id = requireText(runId, 'runId', MAX_IDENTIFIER_CHARS);
    const existing = this.handles.get(id);
    if (existing !== undefined) return existing;
    const run = await this.journal.getRunProjection(id);
    if (run === null || run.projectId !== this.projectId) {
      throw new AgentRuntimeError('RUN_NOT_FOUND', 'Agent Run was not found.', false);
    }
    const environment = await this.journal.getEnvironmentBinding({
      projectId: this.projectId, sessionId: run.sessionId, runId: id,
    });
    if (environment === null) {
      throw new AgentRuntimeError(
        'RUN_STATE_INVALID', 'Agent Run has no durable Environment binding.', false,
      );
    }
    const isDurableChild = run.parent !== undefined;
    const childDriver = this.childDriverKernels.get(id);
    const schedulerOwnsChild = isDurableChild || childDriver !== undefined;
    const kernel = schedulerOwnsChild
      ? await this.kernelForChild(id, run.sessionId)
      : this.kernelFor(
        permissionMode(environment.payload.permissionPolicyRevision),
        await this.ingressConfiguration(id, run.sessionId),
      );
    if (!schedulerOwnsChild) this.kernels.set(id, kernel);
    const handle = this.handleFor(id, run.sessionId);
    if (isDurableChild) {
      await this.recoverDurableChild(run);
      await this.recoverDurableChildren(id);
    } else if (!schedulerOwnsChild) {
      await this.recoverDurableChildren(id);
      if (shouldDriveKernelState(run.state)) this.ensureDriver(id, undefined, run.sessionId);
      else await this.syncQuestionDeadline(id, run.sessionId, kernel);
    }
    return handle;
  }

  private async startDurableRun(
    input: AgentRunInput,
    sessionId: string,
    clientRequestId: string,
  ): Promise<AgentRunHandle> {
    assertIngressSignal(input.signal);
    const message = requireText(input.message, 'message', MAX_MESSAGE_CHARS);
    await this.ensureGlobalConfigReady();
    const clientRequestDigest = agentRunRequestDigest(input, {
      sessionId, clientRequestId, message,
    });
    const existingSession = await this.sessions.get(sessionId);
    this.assertExternallyAddressableSession(sessionId, existingSession);
    const existingBeforePreparation = await this.journal.findRunByClientRequest({
      projectId: this.projectId, sessionId, clientRequestId,
    });
    if (existingBeforePreparation !== null) {
      const persisted = await this.journal.getRunIngressConfiguration({
        projectId: this.projectId, sessionId, runId: existingBeforePreparation.runId,
      });
      if (persisted?.clientRequestDigest !== clientRequestDigest) {
        throw new AgentRuntimeError(
          'IDEMPOTENCY_CONFLICT',
          'clientRequestId was already used for a different Agent Run request.',
          false,
        );
      }
      this.assertRunning();
      const handle = this.handleFor(existingBeforePreparation.runId, sessionId);
      this.ensureDriver(existingBeforePreparation.runId, undefined, sessionId);
      return handle;
    }
    // A failed Capability Skill publication is intentionally retryable at the
    // next public Run boundary. `ready()` remains the eager constructor-health
    // observation API, while Turn preparation reconciles the exact active
    // source generation before any snapshot is captured.
    await this.ensureMcpAutoStarted();
    await this.prepareSkills();
    this.assertRunning();
    assertIngressSignal(input.signal);
    const selection = input.model ?? this.newSessionModel;
    let binding = await this.modelBindings.get(this.projectId, sessionId);
    const newSession = binding === null;
    let previousSkillConfiguration = await this.sessions.skillConfiguration(sessionId);
    const existingIngress = await this.journal.findRunByClientRequest({
      projectId: this.projectId, sessionId, clientRequestId,
    });
    const resumableBootstrap = !newSession && existingSession?.runCount === 0;
    if (binding !== null && (input.model !== undefined || input.sessionParameters !== undefined)) {
      if (!resumableBootstrap && existingIngress === null) {
        throw new AgentRuntimeError(
          'INVALID_INPUT',
          'An existing Session model must be changed through the explicit Session model API.',
          false,
        );
      }
      const persistedSelection = {
        connectionId: binding.model.descriptor.primary.route.connectionId,
        modelId: binding.model.descriptor.primary.route.modelId,
      };
      const requestedSelection = input.model ?? persistedSelection;
      await this.llmConnections.prepare(
        requestedSelection,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (
        requestedSelection.connectionId !== persistedSelection.connectionId ||
        requestedSelection.modelId !== persistedSelection.modelId ||
        (input.sessionParameters !== undefined && JSON.stringify(
          this.llmConnections.effectiveParameters(requestedSelection, {
            session: input.sessionParameters,
          }).values,
        ) !== JSON.stringify(binding.model.descriptor.primary.generation))
      ) {
        throw new AgentRuntimeError(
          'INVALID_INPUT',
          'An existing Session model must be changed through the explicit Session model API.',
          false,
        );
      }
    }
    if (newSession) {
      if (selection === undefined) {
        throw new AgentRuntimeError(
          'NOT_CONFIGURED', 'Select a model for this Session before running the Agent.', true,
        );
      }
      await this.llmConnections.prepare(
        selection,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      const effective = this.llmConnections.effectiveParameters(selection, {
        ...(input.sessionParameters === undefined ? {} : { session: input.sessionParameters }),
      });
      const candidate = await this.llmConnections.prepareModelSessionBundle(selection, {
        generation: effective.values,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertIngressSignal(input.signal);
      this.assertRunning();
      const initialSkills = structuredClone(input.sessionSkills ?? this.defaultSessionSkills);
      const bootstrapped = await this.sessions.bootstrap({
          sessionId,
          commandId: `bootstrap:${clientRequestId}`,
          model: describeRuntimeBinding(candidate),
          definitions: initialSkills,
      });
      binding = bootstrapped.modelBinding;
      previousSkillConfiguration = bootstrapped.skillConfiguration;
    }
    if (binding === null) {
      throw new AgentRuntimeError('NOT_CONFIGURED', 'Session model binding is unavailable.', true);
    }
    if (input.generation !== undefined) {
      const persisted = binding.model.descriptor.primary;
      const runSelection = {
        connectionId: persisted.route.connectionId,
        modelId: persisted.route.modelId,
      };
      await this.llmConnections.prepare(
        runSelection,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      this.llmConnections.effectiveParameters(runSelection, {
        session: persisted.generation,
        request: input.generation,
      });
      assertIngressSignal(input.signal);
    }
    // A new Run always captures the current globally administered default.
    // Restored Runs retain their durable mode while the live enterprise rules
    // are still evaluated on every invocation by resolvePermissionPolicy.
    const requestedMode = this.requireGlobalConfigSnapshot().settings.agent.permission_mode;
    const configuration = this.runConfiguration(input);
    const sessionSkills = structuredClone(input.sessionSkills ??
      previousSkillConfiguration?.definitions ?? []);
    if (!newSession && input.sessionSkills !== undefined) {
      if (!resumableBootstrap && existingIngress === null) {
        throw new AgentRuntimeError(
          'INVALID_INPUT',
          'Existing Session Skills must be changed through the explicit Session Skills API.',
          false,
        );
      }
      if (JSON.stringify(previousSkillConfiguration?.definitions ?? []) !== JSON.stringify(sessionSkills)) {
        throw new AgentRuntimeError(
          existingIngress === null ? 'INVALID_INPUT' : 'IDEMPOTENCY_CONFLICT',
          'The retry Session Skills do not match the persisted Session bootstrap.',
          false,
        );
      }
    }
    assertIngressSignal(input.signal);
    this.assertRunning();
    let kernel = this.kernelFor(requestedMode, configuration, {
      ...(input.generation === undefined ? {} : { requestParameters: input.generation }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const started = await kernel.start({
      projectId: this.projectId,
      sessionId,
      clientRequestId,
      input: message,
      configuration: {
        schemaVersion: 1,
        clientRequestDigest,
        mode: requestedMode,
        ...(configuration.rolePrompt === undefined
          ? {}
          : { rolePrompt: configuration.rolePrompt }),
        capabilityInstructions: [...configuration.capabilityInstructions],
        ...(configuration.allowedTools === undefined
          ? {}
          : { allowedTools: [...configuration.allowedTools] }),
        sessionSkillRevision: previousSkillConfiguration?.revision ?? 0,
      },
    });
    const persistedEnvironment = await this.journal.getEnvironmentBinding({
      projectId: this.projectId, sessionId, runId: started.runId,
    });
    if (persistedEnvironment === null) {
      throw new AgentRuntimeError(
        'RUN_STATE_INVALID', 'Agent Run has no durable Environment binding.', false,
      );
    }
    const persistedMode = permissionMode(persistedEnvironment.payload.permissionPolicyRevision);
    if (persistedMode !== requestedMode) {
      kernel = this.kernelFor(
        persistedMode, await this.ingressConfiguration(started.runId, sessionId),
      );
    }
    this.kernels.set(started.runId, kernel);
    const handle = this.handleFor(started.runId, sessionId);
    this.ensureDriver(started.runId, undefined, sessionId);
    return handle;
  }

  private kernelFor(
    mode: AgentMode,
    configuration: DurableRunConfiguration,
    newRunModel: NewRunModelConfiguration = {},
  ): AgentKernel {
    const baseCatalog = this.tools.captureSnapshot();
    this.ownedToolCatalogs.add(baseCatalog);
    const settingsRevision = this.currentGlobalConfigRevision;
    this.requireGlobalConfigSnapshot();
    const kernel = createJournalAgentKernel({
      journal: this.journal,
      gateway: this.modelGateway,
      resolveUsageBillingMode: ({ session, routeId }) => {
        const sessions = 'primary' in session
          ? [session.primary, ...session.fallbacks]
          : [session];
        const matched = sessions.find((candidate) => candidate.route.routeId === routeId);
        if (matched === undefined) throw new Error(`Unknown Model route for usage: ${routeId}`);
        return this.llmConnections.modelMode({
          connectionId: matched.route.connectionId,
          modelId: matched.route.modelId,
        }) === 'managed' ? 'managed' : 'byok';
      },
      resolveModelSession: async ({ sessionId, binding }) => {
        const persisted = binding ?? await this.modelBindings.get(this.projectId, sessionId);
        if (persisted === null) throw new Error(`Session ${sessionId} has no Model binding.`);
        const descriptor = persisted.model.descriptor.primary;
        const live = await this.llmConnections.prepareModelSessionBundle({
          connectionId: descriptor.route.connectionId,
          modelId: descriptor.route.modelId,
        }, {
          generation: descriptor.generation,
          replay: descriptor.replay,
          ...(descriptor.route.allowedFallbackRouteIds === undefined
            ? {}
            : { allowedFallbackRouteIds: descriptor.route.allowedFallbackRouteIds }),
        });
        return live;
      },
      ...(newRunModel.requestParameters === undefined ? {} : {
        resolveRunModelSession: async ({ binding }) => {
          const descriptor = binding.model.descriptor.primary;
          const selection = {
            connectionId: descriptor.route.connectionId,
            modelId: descriptor.route.modelId,
          };
          await this.llmConnections.prepare(
            selection,
            newRunModel.signal === undefined ? {} : { signal: newRunModel.signal },
          );
          const generation = this.llmConnections.effectiveParameters(selection, {
            session: descriptor.generation,
            ...(newRunModel.requestParameters === undefined
              ? {}
              : { request: newRunModel.requestParameters }),
          }).values;
          return await this.llmConnections.prepareModelSessionBundle(selection, {
            generation,
            replay: descriptor.replay,
            ...(descriptor.route.allowedFallbackRouteIds === undefined
              ? {}
              : { allowedFallbackRouteIds: descriptor.route.allowedFallbackRouteIds }),
            ...(newRunModel.signal === undefined ? {} : { signal: newRunModel.signal }),
          });
        },
      }),
      toolCatalog: baseCatalog,
      permissionManager: this.livePermissionManager,
      artifactStore: this.artifacts,
      revalidateToolTarget: this.revalidateToolTarget,
      mode,
      runtimeProtocol: runtimeProtocolSection(),
      capability: { snapshotId: 'sdk-bootstrap', revision: 'sdk-bootstrap@1' },
      promptRevision: 'sdk-bootstrap@1',
      settingsRevision,
      permissionPolicyRevision: createPermissionPolicyRevision(mode, this.currentGlobalConfigRevision),
      ...(configuration.allowedTools === undefined ? {} : { allowedTools: configuration.allowedTools }),
      captureTurnRuntime: async ({ sessionId, runId, turnId, turnIndex, query, signal }) =>
        await this.captureRuntimeLease(sessionId, runId, configuration, turnIndex, { turnId, query, signal }),
      resolveToolCatalogSnapshot: async ({ sessionId, runId }) => {
        const runtime = await this.captureRuntimeLease(sessionId, runId, configuration);
        return { snapshot: runtime.toolCatalog, release: runtime.release };
      },
      resolvePromptSnapshot: async ({ sessionId, runId }) => {
        const runtime = await this.captureRuntimeLease(sessionId, runId, configuration);
        return {
          revision: runtime.promptRevision,
          runtimeProtocol: runtime.runtimeProtocol,
          sections: runtime.promptSections,
          release: runtime.release,
        };
      },
      resolveInvocationHooks: async ({ sessionId, runId }) => {
        const runtime = await this.captureRuntimeLease(sessionId, runId, configuration);
        const hooks = runtime.invocationHooks ?? [];
        const releases = this.kernelDependencyReleases.get(kernel) ?? [];
        releases.push(runtime.release);
        this.kernelDependencyReleases.set(kernel, releases);
        return hooks;
      },
      resolveVerifier: async ({ sessionId, runId }) => {
        const runtime = await this.captureRuntimeLease(sessionId, runId, configuration);
        if (runtime.verifier === undefined) {
          runtime.release();
          throw new Error('The exact captured verifier is no longer available.');
        }
        return { verifier: runtime.verifier, release: runtime.release };
      },
      resolvePermissionPolicy: ({ permissionPolicyRevision }) => {
        const resolvedMode = permissionMode(permissionPolicyRevision);
        this.requireGlobalConfigSnapshot();
        return {
          // The Run keeps its selected mode, while current enterprise rules are
          // always enforced so an older durable Run cannot bypass a new deny.
          revision: permissionPolicyRevision,
          permissionManager: this.livePermissionManager,
          mode: resolvedMode,
          release: () => undefined,
        };
      },
      runtimeCommandExecutor: async ({ command, application, handlerResult, context }) => {
        if (command.kind === 'discovery.activate') {
          for (const target of command.payload.targets) {
            const binding = command.payload.bindings.find((candidate) =>
              candidate.target.moduleId === target.moduleId &&
              candidate.target.instanceId === target.instanceId)?.binding;
            await this.withCapabilitySkillCriticalSection(async () => {
              await this.capabilities.activate(
                { ...target, ...(binding === undefined ? {} : { binding }) },
                { signal: context.signal, deadline: context.deadline },
              );
              await this.syncCapabilitySkillSources();
            });
          }
          return handlerResult;
        }
        if (!command.kind.startsWith('child.')) {
          throw new Error(`No post-commit executor is registered for ${command.kind}.`);
        }
        if (command.kind === 'child.list') {
          throw new Error('subagent_list is a prepared read and must not emit a Runtime command.');
        }
        if (command.kind === 'child.wait') {
          const child = application.projection.children.find(
            (candidate) => candidate.childRunId === command.payload.childRunId,
          );
          if (child === undefined) throw new Error('Child Run was not found after durable wait intent.');
          const waitRequest = preparedChildWaitResult(handlerResult);
          return await this.waitForChildObservation({
            childRunId: child.childRunId,
            parentRunId: command.origin.runId,
            parentSessionId: application.run.sessionId,
            expectedChildRevision: command.payload.expectedChildRevision,
            timeoutMs: waitRequest.timeoutMs,
            cursor: waitRequest.cursor,
            ...(context.runSignal === undefined ? {} : { signal: context.runSignal }),
          });
        }
        const childRuntime = new JournalAgentSubagentRuntime(this.journal);
        const observation = await childRuntime.execute(command as never, application, {
          ...(context.runSignal === undefined ? {} : { signal: context.runSignal }),
        });
        // A child owns a separate captured Kernel instance.  The parent may
        // finish immediately after durably emitting child.start; releasing its
        // capture must never abort the independently scheduled child driver.
        const childKernel = command.kind === 'child.start'
          ? await this.kernelForChild(observation.childRunId, observation.childSessionId)
          : kernel;
        this.subagentScheduler.schedule(command as never, application, this.questionAwareChildKernel(childKernel, observation.childRunId, observation.childSessionId), {
          // `context.runSignal` belongs to the parent Tool invocation. A
          // successful asynchronous spawn ends that invocation immediately;
          // coupling it to the child driver would cancel a valid child as the
          // parent Tool lane is released. Explicit stop/parent cancellation and
          // scheduler close own child cancellation instead.
          ...(command.kind === 'child.start'
            ? {
              onSettled: () => this.settleChildDriver(
                observation.childRunId, observation.childSessionId, childKernel,
              ),
            }
            : {}),
        });
        return handlerResult;
      },
    });
    this.kernelCatalogs.set(kernel, baseCatalog);
    return kernel;
  }

  private handleFor(runId: string, sessionId: string): AgentRunHandle {
    const existing = this.handles.get(runId);
    if (existing !== undefined) return existing;
    const handle: AgentRunHandle = Object.freeze({
      runId,
      sessionId,
      events: (options: AgentRunEventOptions = {}) => this.runEvents(runId, sessionId, options),
      result: async (options?: AgentRunResultOptions) =>
        await this.waitForResult(runId, sessionId, options),
      steer: async (input: AgentSteeringInput) => {
        this.assertRunning();
        const kernel = await this.kernelForHandle(runId, sessionId);
        await kernel.steer({
          runId,
          clientRequestId: input.clientRequestId ?? randomUUID(),
          input: requireText(input.message, 'message', MAX_MESSAGE_CHARS),
        });
        this.ensureDriver(runId, undefined, sessionId);
      },
      approve: async (input: AgentApprovalDecision) => {
        this.assertRunning();
        try {
          await (await this.kernelForHandle(runId, sessionId)).approve({ runId, ...input });
        } catch (error) {
          throw publicControlError(error);
        }
        this.ensureDriver(runId, undefined, sessionId);
      },
      resolveOutcome: async (input: AgentOutcomeResolution) => {
        this.assertRunning();
        try {
          await (await this.kernelForHandle(runId, sessionId)).resolveOutcome({ runId, ...input });
        } catch (error) {
          throw publicControlError(error);
        }
        this.ensureDriver(runId, undefined, sessionId);
      },
      authorizeRiskyRetry: async (input: AgentRiskyRetryAuthorization) => {
        this.assertRunning();
        try {
          await (await this.kernelForHandle(runId, sessionId)).authorizeRiskyRetry({
            runId,
            invocationId: input.invocationId,
            reason: input.reason,
            clientRequestId: input.clientRequestId ?? randomUUID(),
          });
        } catch (error) {
          throw publicControlError(error);
        }
        this.ensureDriver(runId, undefined, sessionId);
      },
      pendingQuestions: async () =>
        await this.pendingQuestionsForRun(runId, sessionId),
      answerQuestion: async (input: AgentQuestionAnswerInput) => {
        this.assertRunning();
        await this.settleQuestionForRun(runId, sessionId, input.invocationId, {
          kind: 'question.answer',
          commandId: input.clientRequestId?.trim() || randomUUID(),
          questionId: input.questionId,
          questionRevision: input.questionRevision,
          answers: [...input.answers],
        });
      },
      cancelQuestion: async (input: AgentQuestionCancelInput) => {
        this.assertRunning();
        await this.settleQuestionForRun(runId, sessionId, input.invocationId, {
          kind: 'question.cancel',
          commandId: input.clientRequestId?.trim() || randomUUID(),
          questionId: input.questionId,
          questionRevision: input.questionRevision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
      },
      cancel: async (reason?: string) => {
        this.assertRunning();
        const kernel = await this.kernelForHandle(runId, sessionId);
        const cancellationReason = reason ?? 'Cancelled by the parent Runtime.';
        const run = await this.subagentScheduler.cancelTree({
          projectId: this.projectId, rootRunId: runId, reason: cancellationReason, kernel,
        });
        await this.settleTerminal(runId, sessionId, run);
      },
      resume: async (limits?: AgentRunLimits) => {
        this.assertRunning();
        await this.assertChildResumeAllowed(runId);
        await this.drivers.get(runId)?.catch(() => undefined);
        this.assertRunning();
        await (await this.kernelForHandle(runId, sessionId)).resume({ runId });
        this.ensureDriver(runId, limits, sessionId);
      },
      compact: async () => {
        this.assertRunning();
        await (await this.kernelForHandle(runId, sessionId)).requestManualCompaction({ runId });
        this.ensureDriver(runId, undefined, sessionId);
      },
    });
    this.handles.set(runId, handle);
    for (const candidate of this.handles.keys()) {
      if (this.handles.size <= 256) break;
      if (candidate === runId || this.drivers.has(candidate) || this.kernels.has(candidate)) continue;
      this.handles.delete(candidate);
    }
    return handle;
  }

  private async pendingQuestionsForRun(
    runId: string,
    sessionId: string,
  ): Promise<readonly AgentPendingQuestion[]> {
    this.assertRunning();
    const kernel = await this.kernelForHandle(runId, sessionId);
    const pending = await kernel.pending(runId);
    return Object.freeze(pending.flatMap((request) => request.kind === 'tool-question'
      ? [Object.freeze({
          invocationId: request.invocationId,
          questionId: request.bundle.questionId,
          questionRevision: request.bundle.questionRevision,
          questions: Object.freeze(structuredClone(request.bundle.questions)),
          deadline: request.bundle.deadline,
        })]
      : []));
  }

  private async settleQuestionForRun(
    runId: string,
    sessionId: string,
    invocationId: string,
    command: Parameters<AgentKernel['submitQuestion']>[0]['command'],
  ): Promise<void> {
    const operation = this.settleQuestionForRunOwned(runId, sessionId, invocationId, command);
    this.questionSettlements.add(operation);
    try { await operation; } finally { this.questionSettlements.delete(operation); }
  }

  private async settleQuestionForRunOwned(
    runId: string,
    sessionId: string,
    invocationId: string,
    command: Parameters<AgentKernel['submitQuestion']>[0]['command'],
  ): Promise<void> {
    const kernel = await this.kernelForHandle(runId, sessionId);
    this.assertRunning();
    let run;
    try {
      run = await kernel.submitQuestion({ runId, invocationId, command });
    } catch (error) {
      throw publicControlError(error);
    }
    this.clearQuestionDeadline(runId);
    await this.settleTerminal(runId, sessionId, run);
    if (shouldDriveKernelState(run.state)) this.ensureDriver(runId, undefined, sessionId);
    else await this.syncQuestionDeadline(runId, sessionId, kernel);
  }

  private requireKernel(runId: string): AgentKernel {
    const kernel = this.kernels.get(runId);
    if (kernel === undefined) throw new Error(`Run ${runId} is not open in this Runtime.`);
    return kernel;
  }

  private async kernelForHandle(runId: string, sessionId: string): Promise<AgentKernel> {
    await this.ensureGlobalConfigReady();
    const childDriver = this.childDriverKernels.get(runId);
    if (childDriver !== undefined) {
      if (childDriver.sessionId !== sessionId) {
        throw new AgentRuntimeError('RUN_NOT_FOUND', 'Agent Run was not found.', false);
      }
      return childDriver.kernel;
    }
    const existing = this.kernels.get(runId);
    if (existing !== undefined) return existing;
    const run = await this.journal.getRunProjection(runId);
    if (run === null || run.projectId !== this.projectId || run.sessionId !== sessionId) {
      throw new AgentRuntimeError('RUN_NOT_FOUND', 'Agent Run was not found.', false);
    }
    const environment = await this.journal.getEnvironmentBinding({
      projectId: this.projectId, sessionId, runId,
    });
    if (environment === null) {
      throw new AgentRuntimeError(
        'RUN_STATE_INVALID', 'Agent Run has no durable Environment binding.', false,
      );
    }
    const kernel = this.kernelFor(
      permissionMode(environment.payload.permissionPolicyRevision),
      await this.ingressConfiguration(runId, sessionId),
    );
    this.kernels.set(runId, kernel);
    return kernel;
  }

  /** Captures one child-owned driver from that child's durable configuration. */
  private async kernelForChild(childRunId: string, childSessionId: string): Promise<AgentKernel> {
    await this.ensureGlobalConfigReady();
    const existing = this.childDriverKernels.get(childRunId);
    if (existing !== undefined) {
      if (existing.sessionId !== childSessionId) {
        throw new AgentRuntimeError('RUN_NOT_FOUND', 'Child Agent Run was not found.', false);
      }
      return existing.kernel;
    }
    const initializing = this.childKernelInitializations.get(childRunId);
    if (initializing !== undefined) {
      if (initializing.sessionId !== childSessionId) {
        throw new AgentRuntimeError('RUN_NOT_FOUND', 'Child Agent Run was not found.', false);
      }
      return await initializing.operation;
    }
    const operation = (async () => {
      const run = await this.journal.getRunProjection(childRunId);
      if (
        run === null || run.projectId !== this.projectId || run.sessionId !== childSessionId ||
        run.parent === undefined
      ) {
        throw new AgentRuntimeError('RUN_NOT_FOUND', 'Child Agent Run was not found.', false);
      }
      const environment = await this.journal.getEnvironmentBinding({
        projectId: this.projectId, sessionId: childSessionId, runId: childRunId,
      });
      if (environment === null) {
        throw new AgentRuntimeError(
          'RUN_STATE_INVALID', 'Child Agent Run has no durable Environment binding.', false,
        );
      }
      const kernel = this.kernelFor(
        permissionMode(environment.payload.permissionPolicyRevision),
        await this.ingressConfiguration(childRunId, childSessionId),
      );
      this.childDriverKernels.set(childRunId, { sessionId: childSessionId, kernel });
      return kernel;
    })();
    const admission = { sessionId: childSessionId, operation };
    this.childKernelInitializations.set(childRunId, admission);
    try {
      return await operation;
    } finally {
      if (this.childKernelInitializations.get(childRunId) === admission) {
        this.childKernelInitializations.delete(childRunId);
      }
    }
  }

  private ensureDriver(runId: string, limits?: AgentRunLimits, knownSessionId?: string): void {
    if (this.closing || this.closed) return;
    if (this.childDriverKernels.has(runId)) return;
    if (this.drivers.has(runId)) { this.driverWakeRequests.add(runId); return; }
    const sessionId = knownSessionId ?? this.handles.get(runId)?.sessionId;
    if (sessionId === undefined) return;
    let continueDriving = false;
    const operation = (async () => {
      try {
        const kernel = await this.kernelForHandle(runId, sessionId);
        const run = await kernel.advance(runId, limits === undefined ? {} : { limits });
        await this.settleTerminal(runId, run.sessionId, run);
        continueDriving = shouldDriveKernelState(run.state);
        if (!continueDriving) await this.syncQuestionDeadline(runId, run.sessionId, kernel);
      } catch (error) {
        if (this.closing || this.closed) {
          const shutdown = this.parentShutdowns.get(runId);
          if (shutdown === undefined) this.rejectTerminal(runId, error);
          else await shutdown.catch((shutdownError: unknown) => {
            this.rejectTerminal(runId, shutdownError);
          });
          return;
        }
        try {
          const kernel = await this.kernelForHandle(runId, sessionId);
          const interrupted = await kernel.interruptExecution({
            runId,
            code: 'RUNTIME_DRIVER_FAILED',
            detail: runtimeDriverFailureDetail(error),
          });
          await this.settleTerminal(runId, interrupted.sessionId, interrupted);
        } catch (interruptionError) {
          this.rejectTerminal(runId, interruptionError);
        }
      }
    })().finally(() => {
        if (this.drivers.get(runId) !== operation) return;
        this.drivers.delete(runId);
        const requested = this.driverWakeRequests.delete(runId);
        if ((!continueDriving && !requested) || this.closing || this.closed) return;
        this.ensureDriver(runId, limits, sessionId);
      });
    this.drivers.set(runId, operation);
  }

  private clearQuestionDeadline(runId: string): void {
    const timer = this.questionDeadlineTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    this.questionDeadlineTimers.delete(runId);
    this.questionDeadlineGenerations.delete(runId);
  }

  private async syncQuestionDeadline(
    runId: string,
    sessionId: string,
    kernel: AgentKernel,
  ): Promise<void> {
    this.clearQuestionDeadline(runId);
    if (this.closing || this.closed) return;
    const generation = {};
    this.questionDeadlineGenerations.set(runId, generation);
    const question = (await kernel.pending(runId)).find(
      (request) => request.kind === 'tool-question',
    );
    if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation) return;
    if (question?.kind !== 'tool-question' || question.bundle.deadline === null) return;
    const deadline = Date.parse(question.bundle.deadline);
    const remaining = Math.max(0, deadline - Date.now());
    const delay = Math.min(remaining, 2_147_000_000);
    const timer = setTimeout(() => {
      if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation || this.questionDeadlineTimers.get(runId) !== timer) return;
      this.questionDeadlineTimers.delete(runId);
      if (Date.now() < deadline) {
        void this.syncQuestionDeadline(runId, sessionId, kernel).catch(() => {
          const current = this.questionDeadlineGenerations.get(runId);
          if (current) void this.reconcileQuestionDeadline(runId, sessionId, kernel, current);
        });
        return;
      }
      void this.settleQuestionForRun(runId, sessionId, question.invocationId, {
        kind: 'question.timeout',
        commandId: `question-timeout:${question.bundle.questionId}:${question.bundle.questionRevision}`,
        questionId: question.bundle.questionId,
        questionRevision: question.bundle.questionRevision,
        reason: 'Question deadline elapsed.',
      }).catch(() => {
        // Losing to an answer/cancel is a normal resolution race, not a Run
        // failure. Re-read pending state; retain a bounded retry owner if the
        // deadline command itself failed transiently.
        void this.reconcileQuestionDeadline(runId, sessionId, kernel, generation);
      });
    }, delay);
    timer.unref?.();
    this.questionDeadlineTimers.set(runId, timer);
  }

  private async reconcileQuestionDeadline(runId: string, sessionId: string, kernel: AgentKernel, generation: object): Promise<void> {
    if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation) return;
    try {
      const run = await kernel.open(runId);
      if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation) return;
      await this.settleTerminal(runId, sessionId, run);
      if (shouldDriveKernelState(run.state)) { this.clearQuestionDeadline(runId); this.ensureDriver(runId, undefined, sessionId); return; }
    } catch { /* Keep the deadline owner when a transient read also failed. */ }
    if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation) return;
    const timer = setTimeout(() => {
      if (this.closing || this.closed || this.questionDeadlineGenerations.get(runId) !== generation || this.questionDeadlineTimers.get(runId) !== timer) return;
      void this.syncQuestionDeadline(runId, sessionId, kernel).catch(() => {
        const current = this.questionDeadlineGenerations.get(runId);
        if (current) void this.reconcileQuestionDeadline(runId, sessionId, kernel, current);
      });
    }, 250);
    timer.unref?.(); this.questionDeadlineTimers.set(runId, timer);
  }

  /** Hooks the scheduler-owned child path without introducing another driver. */
  private questionAwareChildKernel(kernel: AgentKernel, runId: string, sessionId: string) {
    const sync = async (run: Awaited<ReturnType<AgentKernel['open']>>) => {
      if (run.state === 'AwaitingUser') await this.syncQuestionDeadline(runId, sessionId, kernel);
      else this.clearQuestionDeadline(runId);
      return run;
    };
    return {
      open: async (id: string) => await sync(await kernel.open(id)),
      advance: async (id: string, options?: Parameters<AgentKernel['advance']>[1]) => await sync(await kernel.advance(id, options)),
      steer: kernel.steer.bind(kernel),
      cancel: async (input: Parameters<AgentKernel['cancel']>[0]) => { this.clearQuestionDeadline(runId); return await kernel.cancel(input); },
      interruptExecution: async (input: Parameters<AgentKernel['interruptExecution']>[0]) => { this.clearQuestionDeadline(runId); return await kernel.interruptExecution(input); },
    };
  }

  private async recoverDurableChildren(runId: string): Promise<void> {
    const ancestry = await this.journal.getRunAncestry(runId);
    if (ancestry === null) return;
    const descendants = await this.journal.listRunDescendants({
      projectId: this.projectId, rootRunId: ancestry.rootRunId,
    });
    const subtree = descendants.filter((candidate) =>
      isRunDescendantOf(candidate, runId, descendants));
    for (const descendant of [...subtree].sort((left, right) =>
      left.depth - right.depth || left.runId.localeCompare(right.runId))) {
      const childRun = await this.journal.getRunProjection(descendant.runId);
      if (childRun === null) continue;
      await this.recoverDurableChild(childRun);
    }
  }

  /** Admits one persisted child to the scheduler; duplicate callers share its owner. */
  private async recoverDurableChild(
    childRun: NonNullable<Awaited<ReturnType<SqliteAgentJournal['getRunProjection']>>>,
  ): Promise<void> {
    if (childRun.parent === undefined) return;
    const recovery = await this.recoveredChildStartCommand(childRun);
    if (isTerminalKernelState(childRun.state) && !await this.childNeedsOutcomeReconcile(childRun)) {
      const existing = this.childDriverKernels.get(childRun.runId);
      if (existing !== undefined) this.releaseChildDriver(childRun.runId, existing.kernel);
      return;
    }
    const childKernel = await this.kernelForChild(childRun.runId, childRun.sessionId);
    if (childRun.state === 'AwaitingUser') await this.syncQuestionDeadline(childRun.runId, childRun.sessionId, childKernel);
    this.subagentScheduler.recover({
      projectId: this.projectId,
      childSessionId: childRun.sessionId,
      childRunId: childRun.runId,
      kernel: this.questionAwareChildKernel(childKernel, childRun.runId, childRun.sessionId),
      onSettled: () => this.settleChildDriver(childRun.runId, childRun.sessionId, childKernel),
      ...(recovery === undefined ? {} : { recovery }),
    });
  }

  private async childNeedsOutcomeReconcile(
    childRun: NonNullable<Awaited<ReturnType<SqliteAgentJournal['getRunProjection']>>>,
  ): Promise<boolean> {
    if (childRun.parent === undefined) return false;
    const parentRun = await this.journal.getRunProjection(childRun.parent.runId);
    if (parentRun === null) return false;
    const projection = await this.journal.getRuntimeCommandProjection({
      projectId: this.projectId, sessionId: parentRun.sessionId, runId: parentRun.runId,
    });
    const child = projection?.children.find((entry) => entry.childRunId === childRun.runId);
    return child?.status !== subagentStatusForKernelState(childRun.state);
  }

  /** Reconstructs only the already-committed child.start envelope for recovery. */
  private async recoveredChildStartCommand(
    childRun: NonNullable<Awaited<ReturnType<SqliteAgentJournal['getRunProjection']>>>,
  ): Promise<DurableSubagentOutcomeRecovery | undefined> {
    if (childRun.parent === undefined) return undefined;
    const parentRun = await this.journal.getRunProjection(childRun.parent.runId);
    if (parentRun === null) return undefined;
    const projection = await this.journal.getRuntimeCommandProjection({
      projectId: this.projectId,
      sessionId: parentRun.sessionId,
      runId: parentRun.runId,
    });
    const child = projection?.children.find((entry) => entry.childRunId === childRun.runId);
    if (child?.startCommandId === undefined) return undefined;
    return {
      commandId: child.startCommandId,
      origin: structuredClone(childRun.parent),
      childRunId: childRun.runId,
      childSessionId: childRun.sessionId,
      task: child.task,
      context: structuredClone(child.context),
    };
  }

  private async waitForChildObservation(input: Readonly<{
    childRunId: string;
    parentRunId: string;
    parentSessionId: string;
    expectedChildRevision: number;
    timeoutMs: number;
    cursor: string;
    signal?: AbortSignal;
  }>): Promise<Record<string, PortableValue>> {
    let afterSequence = 0;
    while (true) {
      const page = await this.journal.readRunEvents({
        projectId: this.projectId,
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        afterSequence,
        limit: 1_000,
      });
      if (page.nextSequence === null) break;
      afterSequence = page.nextSequence;
      if (page.events.length < 1_000) break;
    }
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const projection = await this.journal.getRuntimeCommandProjection({
        projectId: this.projectId,
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
      });
      const child = projection?.children.find(
        (candidate) => candidate.childRunId === input.childRunId,
      );
      if (child === undefined) {
        throw new AgentRuntimeError('RUN_NOT_FOUND', 'Child Run was not found.', false);
      }
      if (child.status !== 'running' || child.revision !== input.expectedChildRevision) {
        return childWaitObservation(child, input.timeoutMs, false);
      }
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) return childWaitObservation(child, input.timeoutMs, true, input.cursor);
      const changed = await this.journal.waitRunEvents({
        projectId: this.projectId,
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        afterSequence,
        limit: 128,
        timeoutMs: Math.min(remaining, 30_000),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      afterSequence = changed.nextSequence ?? afterSequence;
    }
  }

  private async *runEvents(
    runId: string,
    sessionId: string,
    options: AgentRunEventOptions,
  ): AsyncIterable<UserActivityEvent> {
    let cursor = options.afterSequence ?? 0;
    let acceptedSequence = cursor;
    while (true) {
      const page = await this.journal.readRunEvents({
        projectId: this.projectId, sessionId, runId,
        afterSequence: acceptedSequence, limit: 1_000,
      });
      for (const source of page.events) {
        if (source.sequence <= acceptedSequence) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'Journal returned a Run event page that did not advance its cursor.',
          );
        }
        acceptedSequence = source.sequence;
        const activity = projectTrustedRunUserActivity(source, {
          ...(source.type === 'run.completed'
            ? { finalText: await this.resolveFinalText(runId, sessionId, source.payload.finalContentRef) }
            : {}),
        });
        if (activity !== undefined && activity.sourceSequence > cursor) {
          cursor = activity.sourceSequence;
          yield activity;
        }
      }
      const expectedNextSequence = page.events.length === 0 ? null : acceptedSequence;
      if (page.nextSequence !== expectedNextSequence) {
        throw new AgentRuntimeError(
          'INTERNAL_ERROR',
          'Journal returned an inconsistent Run event page cursor.',
        );
      }
      // A terminal projection does not imply that this subscriber has drained
      // every earlier Journal page.  Only an empty page proves that its cursor
      // has caught up with the durable Run history.
      if (page.events.length > 0) continue;
      const run = await this.journal.getRunProjection(runId);
      if (run !== null && isTerminalKernelState(run.state)) return;
      const changed = await this.journal.waitRunEvents({
        projectId: this.projectId, sessionId, runId, afterSequence: acceptedSequence,
        limit: 1_000, timeoutMs: 30_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (changed.closed && changed.events.length === 0) return;
    }
  }

  private async skillOverlaysForRun(sessionId: string, runId: string): Promise<SkillOverlay[]> {
    const configured = await this.sessions.skillConfiguration(sessionId);
    if (configured !== null) {
      return configured.definitions.map((definition) => structuredClone(definition));
    }
    void runId;
    return [];
  }

  private defaultRunConfiguration(): DurableRunConfiguration {
    return Object.freeze({
      ...(this.defaultSystemPrompt === undefined
        ? {}
        : { rolePrompt: Object.freeze({ default: durableRolePrompt(this.defaultSystemPrompt) }) }),
      capabilityInstructions: [...this.defaultCapabilityInstructions],
      ...(this.defaultAllowedTools === undefined
        ? {}
        : { allowedTools: [...this.defaultAllowedTools] }),
    });
  }

  private runConfiguration(input: AgentRunInput): DurableRunConfiguration {
    const defaults = this.defaultRunConfiguration();
    const allowedTools = input.allowedTools === undefined
      ? defaults.allowedTools
      : normalizeNameList(input.allowedTools, 'allowedTools');
    return Object.freeze({
      ...((input.systemPrompt === undefined && this.defaultSystemPrompt === undefined)
        ? {}
        : {
            rolePrompt: Object.freeze({
              ...(this.defaultSystemPrompt === undefined
                ? {}
                : { default: durableRolePrompt(this.defaultSystemPrompt) }),
              ...(input.systemPrompt === undefined
                ? {}
                : { run: durableRolePrompt(input.systemPrompt) }),
            }),
          }),
      capabilityInstructions: [
        ...defaults.capabilityInstructions,
        ...normalizeInstructionList(input.capabilityInstructions, 'capabilityInstructions'),
      ],
      ...(allowedTools === undefined ? {} : { allowedTools }),
    });
  }

  private async ingressConfiguration(
    runId: string,
    sessionId: string,
  ): Promise<DurableRunConfiguration> {
    const metadata = await this.journal.getRunIngressConfiguration({
      projectId: this.projectId, sessionId, runId,
    });
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      // An ingress-less Journal record predates durable Run configuration.
      // It must remain an empty legacy contract on replay: applying the
      // current Runtime defaults would rewrite its historical behavior.
      return Object.freeze({ capabilityInstructions: [] });
    }
    return Object.freeze({
      ...(metadata.rolePrompt === undefined
        ? {}
        : { rolePrompt: durableRolePromptConfiguration(metadata.rolePrompt) }),
      capabilityInstructions: [...metadata.capabilityInstructions],
      ...(metadata.allowedTools === undefined
        ? {}
        : { allowedTools: [...metadata.allowedTools] }),
    });
  }

  private async waitForResult(
    runId: string,
    sessionId: string,
    options: AgentRunResultOptions = {},
  ): Promise<DurableAgentRunResult> {
    if (isAbortSignalAborted(options.signal)) {
      throw new AgentRuntimeError('ABORTED', 'Agent Run result subscription was aborted.', false);
    }
    const run = await (await this.kernelForHandle(runId, sessionId)).open(runId);
    const result = await this.resultFromProjection(runId, sessionId, run);
    if (result !== undefined) return result;
    if (isAbortSignalAborted(options.signal)) {
      throw new AgentRuntimeError('ABORTED', 'Agent Run result subscription was aborted.', false);
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      const removeWaiter = () => {
        const current = this.terminalWaiters.get(runId);
        if (current === undefined) return;
        const remaining = current.filter((candidate) => candidate !== waiter);
        if (remaining.length === 0) this.terminalWaiters.delete(runId);
        else this.terminalWaiters.set(runId, remaining);
      };
      const finish = (
        settle: (value: DurableAgentRunResult) => void,
        value: DurableAgentRunResult,
      ) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        removeWaiter();
        settle(value);
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        removeWaiter();
        reject(reason instanceof Error ? reason : new Error('Agent Run operation failed.', { cause: reason }));
      };
      const waiter = {
        resolve: (value: DurableAgentRunResult) => finish(resolve, value),
        reject: fail,
      };
      const onAbort = () => {
        fail(new AgentRuntimeError(
          'ABORTED', 'Agent Run result subscription was aborted.', false,
        ));
      };
      const waiters = this.terminalWaiters.get(runId) ?? [];
      waiters.push(waiter);
      this.terminalWaiters.set(runId, waiters);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.ensureDriver(runId, undefined, sessionId);
      void this.kernelForHandle(runId, sessionId).then((kernel) => kernel.open(runId)).then(
        async (latest) => await this.settleTerminal(runId, sessionId, latest),
        fail,
      );
    });
  }

  private async settleTerminal(runId: string, sessionId: string, run: Awaited<ReturnType<AgentKernel['open']>>) {
    const result = await this.resultFromProjection(runId, sessionId, run);
    if (result === undefined) return;
    this.clearQuestionDeadline(runId);
    for (const waiter of this.terminalWaiters.get(runId) ?? []) waiter.resolve(result);
    this.terminalWaiters.delete(runId);
    this.releaseRunKernel(runId);
    this.handles.delete(runId);
    this.scheduleResultMaterializationCleanup(runId, sessionId);
  }

  private rejectTerminal(runId: string, error: unknown): void {
    for (const waiter of this.terminalWaiters.get(runId) ?? []) waiter.reject(error);
    this.terminalWaiters.delete(runId);
  }

  private releaseRunKernel(runId: string): void {
    const kernel = this.kernels.get(runId);
    if (kernel === undefined) return;
    this.kernels.delete(runId);
    this.releaseKernelInstance(kernel);
  }

  private releaseChildDriver(runId: string, kernel: AgentKernel): void {
    this.clearQuestionDeadline(runId);
    const owner = this.childDriverKernels.get(runId);
    if (owner?.kernel !== kernel) return;
    this.childDriverKernels.delete(runId);
    this.releaseKernelInstance(kernel);
  }

  /** Resolves public child handles before releasing the scheduler-owned capture. */
  private async settleChildDriver(
    runId: string,
    sessionId: string,
    kernel: AgentKernel,
  ): Promise<void> {
    try {
      const run = await kernel.open(runId);
      const result = await this.resultFromProjection(runId, sessionId, run);
      if (result === undefined) {
        throw new AgentRuntimeError(
          'RUNTIME_DRIVER_FAILED', 'Child scheduler settled without a terminal Run.', true,
        );
      }
      for (const waiter of this.terminalWaiters.get(runId) ?? []) waiter.resolve(result);
      this.terminalWaiters.delete(runId);
      this.handles.delete(runId);
      this.scheduleResultMaterializationCleanup(runId, sessionId);
    } catch (error) {
      this.rejectTerminal(runId, error);
    } finally {
      this.releaseChildDriver(runId, kernel);
    }
  }

  private scheduleResultMaterializationCleanup(runId: string, sessionId: string): void {
    queueMicrotask(() => {
      void this.resultMaterializations.cleanupRun({
        hostId: 'local',
        projectId: this.projectId,
        sessionId,
        runId,
      }).catch(() => undefined);
    });
  }

  /** A terminal child outcome is immutable in its parent's durable projection. */
  private async assertChildResumeAllowed(runId: string): Promise<void> {
    const childRun = await this.journal.getRunProjection(runId);
    if (childRun?.parent === undefined || !isTerminalKernelState(childRun.state)) return;
    const parentRun = await this.journal.getRunProjection(childRun.parent.runId);
    if (parentRun === null) return;
    const projection = await this.journal.getRuntimeCommandProjection({
      projectId: this.projectId, sessionId: parentRun.sessionId, runId: parentRun.runId,
    });
    const child = projection?.children.find((entry) => entry.childRunId === runId);
    if (child?.status === subagentStatusForKernelState(childRun.state)) {
      throw new AgentRuntimeError(
        'COMMAND_CONFLICT', 'A terminal delegated child cannot be resumed; spawn a new child Run.', false,
      );
    }
  }

  private releaseKernelInstance(kernel: AgentKernel): void {
    for (const release of this.kernelDependencyReleases.get(kernel) ?? []) release();
    this.kernelDependencyReleases.delete(kernel);
    const catalog = this.kernelCatalogs.get(kernel);
    if (catalog === undefined) return;
    this.kernelCatalogs.delete(kernel);
    this.ownedToolCatalogs.delete(catalog);
    catalog.release();
  }

  private async captureRuntimeLease(
    sessionId: string,
    runId: string,
    configuration: DurableRunConfiguration,
    turnIndex = 1,
    contextRequest?: Readonly<{ turnId: string; query: string; signal: AbortSignal }>,
  ): Promise<JournalAgentTurnRuntimeLease> {
    const projectInstructions = await this.compileProjectInstructions();
    const captured = await this.withCapabilitySkillCriticalSection(async () => {
      // Discovery targets are durable trusted effects. A new Runtime process has
      // no active module generation yet, so restore them before taking the next
      // immutable Turn snapshot. CapabilityControlPlane.activate is idempotent
      // for an already-active record and never replays a terminal Tool result.
      await this.restoreDiscoveredCapabilities(sessionId, runId);
      // Capability publication may have completed while its Skill refresh
      // failed. Always reconcile the exact active source set before capturing
      // a Turn: no snapshot may pair a new Tool/Prompt generation with an old
      // or missing Skill catalog.
      await this.syncCapabilitySkillSources();
      const runtimeState = await this.journal.getRuntimeCommandProjection({
        projectId: this.projectId, sessionId, runId,
      });
      // Skill-source membership and its session view are captured with the
      // same immutable Capability generation as Tools and Prompts.
      const snapshot = this.capabilities.captureRuntimeSnapshot();
      const discoverableCapabilities = await this.captureDiscoveryManifestForRun(sessionId, runId);
      this.capabilityRegistrationClosed = true;
      try {
        const skillRegistry = this.skills.createSessionView(
          await this.skillOverlaysForRun(sessionId, runId),
        ).captureSnapshotView();
        const toolCatalog = replaceCapturedBaseToolInvocation(
          snapshot.tools,
          createSkillToolContribution(skillRegistry),
        );
        return {
          runtimeState,
          snapshot,
          toolCatalog,
          skillRegistry,
          discoverableCapabilities,
        };
      } catch (error) {
        snapshot.release();
        throw error;
      }
    });
    const { runtimeState, snapshot, toolCatalog, skillRegistry, discoverableCapabilities } = captured;
    const skillCatalog = turnIndex === 1 ? boundedSystemSkillCatalog(skillRegistry) : [];
    const activeSkills = [];
    const skillSections = [];
    const activeCapabilitySkillSourceIds = new Set(snapshot.skillSources.map(({ id }) => id));
    try {
      for (const activation of runtimeState?.activeSkills ?? []) {
        if (
          isCapabilitySkillSourceId(activation.revision.sourceId) &&
          !activeCapabilitySkillSourceIds.has(activation.revision.sourceId)
        ) {
          continue;
        }
      let document;
      try {
        document = await skillRegistry.loadRevision(activation.revision);
      } catch (error) {
        throw new AgentRuntimeError(
          'INTERNAL_ERROR',
          `Activated Skill revision is unavailable: ${activation.revision.name}.`,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
      const revision = activation.revision.revisionId;
      activeSkills.push({
        id: activation.id,
        revision,
        ...(activation.allowedTools === undefined ? {} : { allowedTools: activation.allowedTools }),
      });
      skillSections.push(skillPromptSection(activation.id, revision, document.instructions));
    }
      let contextSections: readonly PromptSection[] = [];
      if (contextRequest !== undefined) {
        contextSections = await this.captureCapabilityContextSections(snapshot.contextProviders, {
          projectId: this.projectId,
          sessionId,
          runId,
          turnId: contextRequest.turnId,
          query: contextRequest.query,
          signal: contextRequest.signal,
        });
      }
      const rolePrompt = compileRolePrompt(configuration.rolePrompt);
      let released = false;
      return {
        capability: snapshot.identity,
        toolCatalog,
        promptRevision: `capability:${snapshot.identity.revision}`,
        runtimeProtocol: runtimeProtocolSection(),
        discoverableCapabilities,
        promptSections: [
          ...snapshot.promptSections,
          ...contextSections,
          ...(skillCatalog.length === 0 ? [] : [skillCatalogPromptSection(skillCatalog)]),
          ...(rolePrompt === undefined
            ? []
            : [userPromptSection(rolePrompt)]),
          ...configuration.capabilityInstructions.map(
            (content, index) => capabilityPromptSection(content, index),
          ),
          ...skillSections,
          ...(projectInstructions.trim() === '' ? [] : [projectPromptSection(projectInstructions)]),
        ],
        skills: activeSkills,
        invocationHooks: snapshot.invocationHooks,
        release: () => {
          if (released) return;
          released = true;
          toolCatalog.release();
          snapshot.release();
        },
      };
    } catch (error) {
      toolCatalog.release();
      snapshot.release();
      throw error;
    }
  }

  private async restoreDiscoveredCapabilities(sessionId: string, runId: string): Promise<void> {
    const runtimeState = await this.journal.getRuntimeCommandProjection({
      projectId: this.projectId,
      sessionId,
      runId,
    });
    const targets = runtimeState?.discoveredCapabilities ?? [];
    let restored = false;
    for (const target of targets) {
      const existing = this.capabilities.snapshot().modules.find(
        (module) => module.moduleId === target.moduleId && module.instanceId === target.instanceId,
      );
      if (existing?.active) continue;
      try {
        const binding = runtimeState?.activationBindings.find((candidate) =>
          candidate.target.moduleId === target.moduleId &&
          candidate.target.instanceId === target.instanceId)?.binding;
        await this.capabilities.activate({
          ...target,
          ...(binding === undefined ? {} : { binding }),
        });
        restored = true;
      } catch {
        // A committed discovery may be temporarily unavailable after a host
        // restart. Keep the user Run operable with the last safe catalog; the
        // Control Plane retains its bounded availability failure.
      }
    }
    if (restored) await this.syncCapabilitySkillSources();
  }

  private async captureDiscoveryManifestForRun(
    sessionId: string,
    runId: string,
  ): Promise<readonly AgentCapabilityDiscoveryManifestEntry[]> {
    const owner = Object.freeze({
      hostId: 'local',
      projectId: this.projectId,
      sessionId,
      runId,
    });
    return Object.freeze(await Promise.all(
      this.capabilities.captureDiscoveryManifest().map(async (entry) => {
        if (entry.activation === undefined || entry.activation.selection === 'automatic') return entry;
        const candidates = await Promise.all(entry.activation.candidates.map(async (candidate) => {
          const record = await this.probeChoices.issue({
            providerId: entry.activation!.providerId,
            candidateId: candidate.candidateId,
            probeRevision: entry.activation!.probeRevision,
            owner,
          });
          return Object.freeze({ ...candidate, probeChoiceRef: record.ref });
        }));
        return Object.freeze({
          ...entry,
          activation: Object.freeze({ ...entry.activation, candidates: Object.freeze(candidates) }),
        });
      }),
    ));
  }

  /**
   * Executes Context Providers once while a new Turn dependency generation is
   * captured. Their successful bytes are persisted in the Turn Snapshot; a
   * replay therefore never re-runs a provider. Failures are isolated to that
   * provider, while cancellation remains a hard boundary for the whole Turn.
   */
  private async captureCapabilityContextSections(
    providers: readonly AgentCapabilityContextProviderContribution[],
    input: Readonly<{
      projectId: string;
      sessionId: string;
      runId: string;
      turnId: string;
      query: string;
      signal: AbortSignal;
    }>,
  ): Promise<readonly PromptSection[]> {
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Context Provider host deadline exceeded.')),
      this.contextProviderHostDeadlineMs,
    );
    const sections: PromptSection[] = [];
    let remaining = CONTEXT_PROVIDER_HOST_TOKEN_BUDGET;
    try {
      for (const provider of providers) {
        if (remaining <= 0) break;
        if (controller.signal.aborted) throw controller.signal.reason;
        try {
          const provided = await awaitAbortable(
            provider.provide({
              ...input,
              maxTokens: remaining,
              signal: controller.signal,
            }),
            controller.signal,
          );
          for (const section of provided) {
            if (section.tokenEstimate > remaining) break;
            sections.push(section);
            remaining -= section.tokenEstimate;
          }
          this.contextProviderDiagnostics.delete(provider.id);
        } catch (error) {
          if (input.signal.aborted) throw error;
          this.recordContextProviderDiagnostic(provider.id, error);
          // The bounded host deadline aborts the non-cooperative provider race.
          // The detached in-process promise may settle later, but its rejection
          // is already observed by awaitAbortable and cannot hold this Turn.
          if (controller.signal.aborted) break;
        }
      }
      return Object.freeze(sections);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
    }
  }

  private recordContextProviderDiagnostic(providerId: string, error: unknown): void {
    this.contextProviderDiagnostics.set(
      providerId,
      error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    );
    while (this.contextProviderDiagnostics.size > 64) {
      const first = this.contextProviderDiagnostics.keys().next().value;
      if (first === undefined) break;
      this.contextProviderDiagnostics.delete(first);
    }
  }

  private async resultFromProjection(runId: string, sessionId: string, run: Awaited<ReturnType<AgentKernel['open']>>): Promise<DurableAgentRunResult | undefined> {
    if (!isTerminalKernelState(run.state)) return undefined;
    const completion = run.state === 'Completed'
      ? await this.journal.getRunCompletion({ projectId: this.projectId, sessionId, runId })
      : null;
    const terminalFailure = run.state === 'Failed' || run.state === 'Interrupted'
      ? await this.journal.getRunTerminalFailure({
          projectId: this.projectId, sessionId, runId,
        })
      : null;
    const finalText = run.finalContentRef === null
      ? ''
      : await this.resolveFinalText(runId, sessionId, run.finalContentRef);
    return Object.freeze({
      runId, sessionId, status: kernelResultStatus(run.state), finalText,
      ...(run.finalContentRef === null ? {} : { finalContentRef: run.finalContentRef }),
      ...(run.deliveryStatus === null ? {} : { deliveryStatus: run.deliveryStatus }),
      evidenceRevision: run.evidenceRevision,
      evidenceRefs: Object.freeze([...(completion?.evidenceRefs ?? [])]),
      ...(terminalFailure === null ? {} : {
        error: Object.freeze({
          code: terminalFailure.code,
          ...(terminalFailure.detail === undefined
            ? {}
            : { detail: structuredClone(terminalFailure.detail) }),
        }),
      }),
    });
  }

  private async resolveFinalText(
    runId: string,
    sessionId: string,
    finalContentRef: string,
  ): Promise<string> {
    const match = /^turn:([^:]+):(?:content|text:\d+)$/u.exec(finalContentRef);
    if (match === null) return '';
    const turn = await this.journal.getScopedCommittedTurn({
      projectId: this.projectId,
      sessionId,
      runId,
      turnId: match[1]!,
    });
    if (turn === null) return '';
    return turn.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  async runAgent(input: AgentRunInput): Promise<DurableAgentRunResult> {
    return await (await this.startAgentRun(input)).result();
  }

  async listAgentSessions(input: AgentSessionListInput = {}): Promise<AgentSessionListPage> {
    const page = await this.sessions.list({
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      limit: input.limit ?? 100,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return {
      items: page.items.map((session) => ({
        sessionId: session.sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        archived: session.archived,
        runCount: session.runCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionView | undefined> {
    const id = requireText(sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const [session, conversation] = await Promise.all([
      this.sessions.get(id),
      this.sessions.load(id, { limit: 1_000 }),
    ]);
    if (session === null) return undefined;
    return {
      sessionId: id,
      ...(session.title === undefined ? {} : { title: session.title }),
      archived: session.archived,
      runCount: session.runCount,
      messages: conversation.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        })),
      ...(session.modelBinding === undefined ? {} : {
        model: {
          connectionId: session.modelBinding.connectionId,
          modelId: session.modelBinding.modelId,
          parameters: structuredClone(session.modelBinding.parameters),
        },
      }),
      skillRevision: session.skillConfiguration.revision,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async setAgentSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    this.assertRunning();
    const id = requireText(sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const current = await this.sessions.get(id);
    if (current === null) {
      throw new AgentRuntimeError('INVALID_INPUT', `Session was not found: ${id}`, false);
    }
    this.assertExternallyAddressableSession(id, current);
    await this.sessions.setArchived({
      sessionId: id,
      commandId: `archive:${randomUUID()}`,
      expectedRevision: current.archiveRevision,
      archived,
    });
  }

  async configureSessionSkills(input: ConfigureSessionSkillsInput): Promise<AgentSessionView> {
    this.assertRunning();
    const sessionId = requireText(input.sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
    const current = await this.sessions.get(sessionId);
    if (current === null) {
      throw new AgentRuntimeError('INVALID_INPUT', `Session was not found: ${sessionId}`, false);
    }
    this.assertExternallyAddressableSession(sessionId, current);
    await this.sessions.configureSkills({
      sessionId,
      commandId: `skills:${randomUUID()}`,
      expectedRevision: input.expectedRevision ?? current.skillConfiguration.revision,
      definitions: structuredClone([...input.definitions]),
    });
    return (await this.getAgentSession(sessionId))!;
  }

  async listAgentSkills(input: AgentSkillListInput = {}): Promise<AgentSkillCatalogEntry[]> {
    this.assertRunning();
    await this.prepareSkills();
    if (!input.sessionId?.trim()) return this.skills.catalogForModel();
    const session = await this.sessions.get(
      requireText(input.sessionId, 'sessionId', MAX_IDENTIFIER_CHARS),
    );
    if (session === null) {
      throw new AgentRuntimeError(
        'INVALID_INPUT',
        `Session was not found: ${input.sessionId.trim()}`,
        false,
      );
    }
    return this.skills.createSessionView(
      session.skillConfiguration.definitions,
    ).catalogForModel();
  }

  async inspectAgentSkill(input: Readonly<{
    name: string;
    scope?: AgentSkillCatalogEntry['scope'];
    sessionId?: string;
  }>): Promise<AgentSkillInspection | undefined> {
    this.assertRunning();
    const name = requireText(input.name, 'name', MAX_IDENTIFIER_CHARS);
    const scope = input.scope;
    await this.prepareSkills();
    let registry = this.skills;
    if (input.sessionId !== undefined) {
      const sessionId = requireText(input.sessionId, 'sessionId', MAX_IDENTIFIER_CHARS);
      const session = await this.sessions.get(sessionId);
      if (session === null) {
        throw new AgentRuntimeError('INVALID_INPUT', `Session was not found: ${sessionId}`, false);
      }
      this.assertExternallyAddressableSession(sessionId, session);
      registry = this.skills.createSessionView(session.skillConfiguration.definitions);
    }
    const descriptor = registry.inspect({ name, ...(scope === undefined ? {} : { scope }) });
    return descriptor === undefined
      ? undefined
      : {
          name: descriptor.name,
          description: descriptor.description,
          scope: descriptor.scope,
          sourcePath: descriptor.sourcePath,
        };
  }

  async refreshSkills(): Promise<AgentSkillRefreshResult> {
    this.assertRunning();
    return await this.withCapabilitySkillCriticalSection(async () => {
      await this.syncCapabilitySkillSources();
      const refresh = this.skills.refresh();
      this.skillsReady = this.observeSkillRefresh(refresh);
      const result = await refresh;
      await this.skillsReady;
      if (this.skillInitializationError !== undefined) throw this.skillInitializationError;
      return result;
    });
  }

  async listMcpServers(): Promise<McpServerSummary[]> {
    this.assertRunning();
    return (await this.mcpConfig.list()).map((server) =>
      toMcpServerSummary(server, this.mcp.health(server.id), this.mcp.isRunning(server.id)),
    );
  }

  async upsertMcpServer(input: McpServerInput): Promise<McpServerSummary> {
    this.assertRunning();
    let server: McpServerConfig;
    try {
      server = await this.mcpConfig.upsert(input);
    } catch (error) {
      throw new AgentRuntimeError(
        'INVALID_INPUT',
        error instanceof Error ? error.message : 'Invalid MCP server configuration.',
        false,
      );
    }
    if (this.mcp.isRunning(server.id)) await this.mcp.stop(server.id);
    this.mcpAutoStartPromise = undefined;
    return toMcpServerSummary(server, this.mcp.health(server.id), this.mcp.isRunning(server.id));
  }

  async removeMcpServer(serverId: string): Promise<boolean> {
    this.assertRunning();
    const id = requireText(serverId, 'serverId', MAX_IDENTIFIER_CHARS);
    if (this.mcp.isRunning(id)) await this.mcp.stop(id);
    const removed = (await this.mcpConfig.remove(id)).removed;
    if (removed) this.mcpAutoStartPromise = undefined;
    return removed;
  }

  async startMcpServer(serverId: string): Promise<McpServerStartSummary> {
    this.assertRunning();
    const id = requireText(serverId, 'serverId', MAX_IDENTIFIER_CHARS);
    const configured = await this.mcpConfig.list();
    this.assertRunning();
    if (!configured.some((server) => server.id === id)) {
      throw new AgentRuntimeError('INVALID_INPUT', `MCP server was not found: ${id}`, false);
    }
    const started = await this.mcp.start(id);
    return {
      server: toMcpServerSummary(
        started.server,
        started.health,
        this.mcp.isRunning(started.server.id),
      ),
      tools: [...started.tools],
    };
  }

  async stopMcpServer(serverId: string): Promise<McpServerStopSummary> {
    this.assertRunning();
    const stopped = await this.mcp.stop(requireText(serverId, 'serverId', MAX_IDENTIFIER_CHARS));
    return {
      serverId: stopped.serverId,
      removedTools: [...stopped.removedTools],
      status: stopped.health.status,
    };
  }

  async startConfiguredMcpServers() {
    this.assertRunning();
    return await this.mcp.startAutoStart(this.mcpStartupSequenceController.signal);
  }

  async llmChat(
    request: LlmRuntimeChatRequest,
    options: LlmRuntimeCallOptions,
  ): Promise<LlmChatResponse> {
    this.assertRunning();
    return await this.directLlm.chat(request, options);
  }

  llmStream(
    request: LlmRuntimeChatRequest,
    options: LlmRuntimeCallOptions,
  ): AsyncIterable<LlmChatStreamEvent> {
    this.assertRunning();
    return this.directLlm.stream(request, options);
  }

  submitLlmBatch(
    items: LlmRuntimeBatchItem[],
    options: LlmRuntimeBatchOptions = {},
  ): LlmAsyncJob<DirectLlmExecutionResult> {
    this.assertRunning();
    return this.directLlm.submitBatch(items, options);
  }

  getLlmJob(id: string): LlmAsyncJob<DirectLlmExecutionResult> | undefined {
    return this.directLlm.getJob(id);
  }

  cancelLlmJob(id: string): LlmAsyncJob<DirectLlmExecutionResult> | undefined {
    return this.directLlm.cancelJob(id);
  }

  llmMetrics(): LlmMetricsSnapshot {
    return this.directLlm.metrics();
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    if (this.closed) return Promise.resolve();
    if (this.closing) this.parentShutdowns.clear();
    this.closing = true;
    if (!this.mcpStartupSequenceController.signal.aborted) {
      this.mcpStartupSequenceController.abort(
        new AgentRuntimeError('ABORTED', 'SchemaNaut runtime is closing.', false),
      );
    }
    for (const runId of this.questionDeadlineGenerations.keys()) this.clearQuestionDeadline(runId);
    this.driverWakeRequests.clear();
    // Begin the execution fence synchronously with close admission. Waiting
    // for constructor work before releasing these leases would leave a window
    // in which an already rejected Model call could commit a normal failure.
    for (const [runId, kernel] of this.kernels) {
      void this.beginParentShutdown(runId, kernel);
    }
    const operation = this.closeInternal();
    this.closeOperation = operation;
    void operation.catch(() => {
      if (this.closeOperation === operation) this.closeOperation = undefined;
    });
    return operation;
  }

  private beginParentShutdown(runId: string, kernel: AgentKernel): Promise<void> {
    const existing = this.parentShutdowns.get(runId);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const failures: unknown[] = [];
      // Fence publication before scanning: an old handler cannot publish a new
      // question behind the scan. Host submitQuestion obtains a fresh scoped
      // controller; it does not need the released execution writer's lease.
      try {
        await kernel.releaseExecution(runId);
        await Promise.allSettled([...this.questionSettlements]);
        await kernel.releaseExecution(runId);
        for (let attempt = 0; attempt < 32; attempt++) {
          const pending = (await kernel.pending(runId)).filter(request => request.kind === 'tool-question');
          if (pending.length === 0) break;
          for (const request of pending) {
            if (request.kind !== 'tool-question') continue;
            try {
              await kernel.submitQuestion({
                runId,
                invocationId: request.invocationId,
                command: {
                  kind: 'question.cancel',
                  commandId: `runtime-shutdown:${request.bundle.questionId}:${request.bundle.questionRevision}`,
                  questionId: request.bundle.questionId,
                  questionRevision: request.bundle.questionRevision,
                  reason: 'Runtime shutdown.',
                },
              });
            } catch (error) {
              const current = await this.journal.getInvocation(request.invocationId);
              if (current?.observation === undefined || current.observation === null) throw error;
              // Another admitted answer/timeout already produced the unique
              // terminal observation. Its benign conflict is fully settled.
            }
          }
          if (attempt === 31) throw new AgentRuntimeError('RUN_STATE_INVALID', 'Question shutdown did not converge.', true);
        }
      } catch (error) {
        failures.push(error);
      }
      // Revoke the writer after passive questions are settled. In-flight
      // callbacks may still settle, but RunController.assertLeaseActive()
      // prevents them from committing after this point.
      try {
        await kernel.releaseExecution(runId);
      } catch (error) {
        failures.push(error);
      }
      try {
        const interrupted = await kernel.interruptExecution({
          runId,
          code: 'RUNTIME_SHUTDOWN',
          detail: { category: 'runtime-shutdown' },
        });
        await this.settleTerminal(runId, interrupted.sessionId, interrupted);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Parent Agent Run ${runId} could not be interrupted during close.`,
        );
      }
    })();
    this.parentShutdowns.set(runId, operation);
    // closeInternal owns observation, but attach a handler immediately so a
    // fast dependency failure cannot surface as unhandled first.
    void operation.catch(() => undefined);
    return operation;
  }

  private async closeInternal(): Promise<void> {
    const failures: unknown[] = [];
    // Stop admitting global configuration changes before draining constructor work. A
    // watcher created concurrently observes `closing` and closes itself.
    this.stopGlobalConfigWatcher?.();
    this.stopGlobalConfigWatcher = undefined;
    const capabilitySkillDrain = this.capabilitySkillCriticalSection;
    const admittedRunStarts = [...this.starts.values()];
    // The constructor observes the initial refresh immediately. Drain that
    // observer before tearing resources down, but never let an injected
    // config store or Skill source make close() hang forever. On timeout we
    // leave dependencies intact and allow a later close() call to retry.
    const initializationSettled = await settleWithinDeadline(
      [
        this.globalConfigReady,
        this.skillsReady,
        this.resultMaterializationsReady,
        capabilitySkillDrain,
        ...admittedRunStarts,
      ],
      this.initializationCloseDeadlineMs,
    );
    if (!initializationSettled) {
      throw new AggregateError([
        new AgentRuntimeError(
          'RUNTIME_DRIVER_FAILED',
          'Runtime initialization did not settle during close.',
          true,
        ),
      ], 'SchemaNaut runtime is still draining initialization work.');
    }
    // Quiesce parent drivers before cancelling children. A parent may be
    // blocked in child.wait; cancelling the child first would wake that parent
    // and admit another model turn while shutdown is already in progress.
    // A Run start admitted before closing may have published its Kernel while
    // initialization was draining. It joins the same close-owned fence here;
    // no new Run can be admitted after `closing` became true.
    for (const [runId, kernel] of this.kernels) {
      void this.beginParentShutdown(runId, kernel);
    }
    const parentShutdowns = await Promise.allSettled([...this.parentShutdowns.values()]);
    for (const result of parentShutdowns) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    // releaseExecution aborts active Kernel work. Do not tear down any shared
    // dependency while a parent driver can still resume and touch it.
    const parentDrivers = [...this.drivers.values()];
    const driverDrain = await Promise.race([
      Promise.allSettled(parentDrivers),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    if (driverDrain === 'timeout') {
      failures.push(new AgentRuntimeError(
        'RUNTIME_DRIVER_FAILED', 'Parent Agent drivers did not drain during Runtime close.', true,
      ));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime is still draining Agent work.');
    }
    this.drivers.clear();
    this.parentShutdowns.clear();

    try {
      // Parent execution is now fenced. The scheduler can cancel and drain
      // child-owned Kernels without waking a live parent into fresh work.
      await this.subagentScheduler.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime is still draining child Agent work.');
    }

    // MCP must withdraw its external providers while the Capability control
    // plane is still open. If that boundary fails, keep every downstream host
    // dependency alive so a later close() can safely retry.
    try {
      await this.mcp.stopAll();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime could not stop MCP providers.');
    }

    // Capability shutdown can return a bounded, retryable timeout while its
    // background reaper continues. Never close model/process dependencies or
    // release catalogs until it has actually completed.
    try {
      await this.capabilities.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime is still draining Capabilities.');
    }

    if (!this.usageProjectionReleased) {
      try {
        this.releaseUsageProjection();
        this.usageProjectionReleased = true;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const catalog of this.ownedToolCatalogs) catalog.release();
    this.ownedToolCatalogs.clear();
    try {
      await this.webTools.drain({
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 5_000).toISOString(),
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.workspaceTools.drain();
    } catch (error) {
      failures.push(error);
    }
    if (this.resultMaterializationInitializationError !== undefined) {
      // Initialization failures are retained for ready()/Run admission. Do
      // not overwrite the original cause during shutdown by asking an
      // uninitialized store to drain or clean up.
      failures.push(this.resultMaterializationInitializationError);
    } else {
      try {
        await this.resultMaterializations.drain();
        await this.resultMaterializations.cleanupAll();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.artifacts.drain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.processes.close();
    } catch {
      // ProcessRuntime.close() is intentionally bounded. The Host retains the
      // real shutdown owner and must observe it before releasing dependencies.
      try {
        await this.processes.drain();
      } catch (drainError) {
        failures.push(drainError);
      }
    }
    try {
      await this.directLlm.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime did not close cleanly.');
    }
    this.closed = true;
    this.closing = false;
  }

  private async prepareSkills(): Promise<void> {
    await this.withCapabilitySkillCriticalSection(async () => {
      await this.syncCapabilitySkillSources();
      await this.skillsReady;
      if (this.skillInitializationError !== undefined) throw this.skillInitializationError;
    });
  }

  private async syncCapabilitySkillSources(): Promise<void> {
    const synchronize = async (): Promise<void> => {
      const contributed = this.capabilities.skillSources();
      const signature = JSON.stringify(contributed);

      // A previous failure is deliberately not a committed generation. Re-run
      // the refresh even when the desired source list itself did not change.
      if (signature === this.committedCapabilitySkillSourceSignature) {
        await this.skillsReady;
        if (this.skillInitializationError === undefined) return;
      } else {
        this.skills.setSources([
          ...this.baseSkillSources,
          ...contributed.map((source) => ({
            scope: source.scope,
            path: source.path,
            id: source.id,
          })),
        ]);
      }

      const refresh = this.skills.refresh();
      this.skillsReady = this.observeSkillRefresh(refresh);
      await this.skillsReady;
      if (this.skillInitializationError !== undefined) throw this.skillInitializationError;
      this.committedCapabilitySkillSourceSignature = signature;
    };

    const next = this.capabilitySkillSourceSync.catch(() => undefined).then(synchronize);
    this.capabilitySkillSourceSync = next;
    await next;
  }

  private async withCapabilitySkillCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.capabilitySkillCriticalSection;
    this.capabilitySkillCriticalSection = previous.catch(() => undefined).then(() => next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private observeSkillRefresh(refresh: Promise<unknown>): Promise<void> {
    return refresh.then(
      () => { this.skillInitializationError = undefined; },
      (error: unknown) => {
        this.skillInitializationError = error instanceof Error ? error : new Error(String(error));
      },
    );
  }

  private async ensureMcpAutoStarted(): Promise<void> {
    if (!this.autoStartMcp) return;
    this.assertRunning();
    if (this.mcpAutoStartPromise === undefined) {
      const operation = this.mcp.startAutoStart(this.mcpStartupSequenceController.signal);
      this.mcpAutoStartPromise = operation;
      void operation.then((results) => {
        if (
          this.mcpAutoStartPromise === operation &&
          results.some((result) => result.server.enabled && !result.health.healthy)
        ) {
          // An unavailable server is a published health result, not a rejected
          // Promise. Leave the Runtime usable but retry on the next boundary.
          this.mcpAutoStartPromise = undefined;
        }
      }, () => undefined);
      void operation.catch(() => {
        if (this.mcpAutoStartPromise === operation) this.mcpAutoStartPromise = undefined;
      });
    }
    await this.mcpAutoStartPromise;
    this.assertRunning();
  }

  private async compileProjectInstructions(): Promise<string> {
    const compilation = await compileProjectContext({
      rootPath: this.project.rootPath,
    });
    return compilation.compiledInstructions;
  }

  private async initializeGlobalConfig(): Promise<void> {
    const initial = await this.globalConfig.load();
    if (this.closing || this.closed) return;
    try {
      await this.applyGlobalConfigSnapshot(initial);
    } finally {
      await this.ensureGlobalConfigWatcher();
    }
  }

  private async initializeResultMaterializations(): Promise<void> {
    await this.resultMaterializations.initialize(async (owner) => {
      if (owner.hostId !== 'local' || owner.projectId !== this.projectId) return false;
      const run = await this.journal.getRunProjection(owner.runId);
      return run !== null && run.projectId === this.projectId &&
        run.sessionId === owner.sessionId && !isTerminalKernelState(run.state);
    });
  }

  private async ensureGlobalConfigWatcher(): Promise<void> {
    if (this.stopGlobalConfigWatcher || this.closing || this.closed) return;
    const stop = await this.globalConfig.watch(
      async (current) => {
        if (this.closing || this.closed) return;
        await this.applyGlobalConfigSnapshot(current);
      },
      {
        ...(this.globalConfigSnapshot === undefined
          ? {}
          : { initialSnapshot: this.globalConfigSnapshot }),
        onError: (error) => this.recordGlobalConfigApplicationError(error),
      },
    );
    if (this.closing || this.closed) {
      stop();
      return;
    }
    this.stopGlobalConfigWatcher = stop;
  }

  private applyGlobalConfigSnapshot(snapshot: GlobalConfigSnapshot): Promise<void> {
    const operation = this.globalConfigApplyTail.then(
      () => this.applyGlobalConfigSnapshotNow(snapshot),
      () => this.applyGlobalConfigSnapshotNow(snapshot),
    );
    this.globalConfigApplyTail = operation.catch(() => undefined);
    return operation;
  }

  private applyGlobalConfigSnapshotNow(snapshot: GlobalConfigSnapshot): void {
    this.targetGlobalConfigRevision = snapshot.revision;
    try {
      // Validate before publishing; the live manager swap below is atomic.
      new PermissionManager({
        rules: snapshot.settings.permissions.rules,
        revision: snapshot.revision,
      });
      if (this.ownsLlmConnections) {
        const connections = this.globalConfig.resolveModelConnections(
          process.env,
          this.globalSecretResolver,
          snapshot,
        );
        this.llmConnections.replaceConfiguration({
          connections: connections.map((connection, index) => ({
            ...connection,
            connectionConfigurationRevision:
              `global-config:${snapshot.revision}:connection:${index}`,
            credentialRevision: `global-config:${snapshot.revision}:credential:${index}`,
          })),
          globalParameters: snapshot.settings.models.parameters,
        });
      }
      this.processes.updateGlobalPolicy({ revision: snapshot.revision, mode: snapshot.settings.agent.permission_mode, requireSandbox: snapshot.settings.agent.require_sandbox });
      if (this.closing || this.closed) {
        throw new AgentRuntimeError('ABORTED', 'SchemaNaut runtime is closing.', false);
      }
      this.livePermissionManager.replacePolicy({
        rules: snapshot.settings.permissions.rules,
        revision: snapshot.revision,
      });
      this.globalConfigSnapshot = snapshot;
      this.currentGlobalConfigRevision = snapshot.revision;
      this.globalConfigInitializationError = undefined;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.recordGlobalConfigApplicationError(failure, snapshot.revision);
      throw failure;
    }
  }

  private recordGlobalConfigApplicationError(error: Error, targetRevision?: string): void {
    this.targetGlobalConfigRevision = targetRevision ??
      `global-config:rejected:${createHash('sha256').update(error.message).digest('hex')}`;
    this.globalConfigInitializationError = error;
  }

  private requireGlobalConfigSnapshot(): GlobalConfigSnapshot {
    if (this.globalConfigSnapshot !== undefined) return this.globalConfigSnapshot;
    throw new AgentRuntimeError(
      'NOT_CONFIGURED',
      `Global configuration is not ready: ${this.globalConfig.path}`,
      true,
    );
  }

  private async ensureGlobalConfigReady(): Promise<void> {
    await Promise.all([this.globalConfigReady, this.resultMaterializationsReady]);
    if (this.globalConfigInitializationError !== undefined) {
      throw this.globalConfigInitializationError;
    }
    if (this.resultMaterializationInitializationError !== undefined) {
      throw this.resultMaterializationInitializationError;
    }
    this.requireGlobalConfigSnapshot();
  }

  private assertRunning(): void {
    if (this.closing || this.closed) {
      throw new AgentRuntimeError('ABORTED', 'SchemaNaut runtime is closing.', false);
    }
  }

  private assertExternallyAddressableSession(
    sessionId: string,
    session: Awaited<ReturnType<JournalSessionStore['get']>>,
  ): void {
    const identity = session as (typeof session & Readonly<{
      kind?: 'root' | 'delegated';
      visibility?: 'public' | 'internal';
    }>);
    if (identity?.kind === 'delegated' || identity?.visibility === 'internal') {
      throw new AgentRuntimeError(
        'INVALID_INPUT',
        `Delegated Session ${sessionId} is owned by its child Run and is not externally addressable.`,
        false,
      );
    }
  }

}

function toMcpServerSummary(
  server: McpServerConfig,
  health: McpServerHealthState,
  running: boolean,
): McpServerSummary {
  return {
    id: server.id,
    name: server.name,
    source: server.source,
    transport: server.transport,
    enabled: server.enabled,
    autoStart: server.autoStart,
    running,
    status: health.status,
    healthy: health.healthy,
    warnings: [...health.warnings],
  };
}

function normalizeModelSelection(selection: LlmModelSelection): LlmModelSelection {
  return {
    connectionId: requireText(selection.connectionId, 'connectionId', MAX_IDENTIFIER_CHARS),
    modelId: requireText(selection.modelId, 'modelId', MAX_IDENTIFIER_CHARS),
    ...(selection.routeRevision?.trim()
      ? {
          routeRevision: requireText(
            selection.routeRevision,
            'routeRevision',
            MAX_IDENTIFIER_CHARS,
          ),
        }
      : {}),
  };
}

function prevalidateAgentRuntimeOptions(
  options: AgentRuntimeOptions,
): PreparedAgentRuntimeOptions {
  if (options.interactive !== undefined && typeof options.interactive !== 'boolean') {
    throw new AgentRuntimeError('INVALID_INPUT', 'interactive must be a boolean.', false);
  }
  return {
    newSessionModel:
      options.newSessionModel === undefined ? undefined : normalizeModelSelection(options.newSessionModel),
    defaultSessionSkills: structuredClone(options.sessionSkills ?? []),
    defaultSystemPrompt:
      options.systemPrompt === undefined ? undefined : durableRolePrompt(options.systemPrompt),
    defaultCapabilityInstructions: normalizeInstructionList(
      options.capabilityInstructions,
      'capabilityInstructions',
    ),
    defaultAllowedTools: normalizeOptionalNameList(options.allowedTools, 'allowedTools'),
    webAdapter: normalizeWebAdapter(options.webAdapter),
    interactive: options.interactive === true,
  };
}

function normalizeWebAdapter(
  adapter: AgentRuntimeOptions['webAdapter'],
): AgentRuntimeOptions['webAdapter'] {
  if (adapter === undefined) return undefined;
  try {
    return structuredClone(adapter);
  } catch (error) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      'webAdapter must be a portable static search adapter descriptor.',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function composeToolTargetRevalidators(
  revalidators: readonly ToolTargetRevalidator[],
): ToolTargetRevalidator {
  const captured = Object.freeze([...revalidators]);
  return async (intent, context) => {
    for (const revalidate of captured) {
      const result = await revalidate(intent, context);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}

function preparedChildWaitResult(value: PortableValue): Readonly<{
  timeoutMs: number;
  cursor: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subagent_wait returned an invalid sealed wait request.');
  }
  const record = value as Record<string, PortableValue>;
  if (
    typeof record.timeoutMs !== 'number' || !Number.isSafeInteger(record.timeoutMs) ||
    record.timeoutMs < 0 || record.timeoutMs > 30_000 ||
    typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 1_024
  ) {
    throw new Error('subagent_wait returned an invalid sealed wait request.');
  }
  return Object.freeze({ timeoutMs: record.timeoutMs, cursor: record.cursor });
}

function childWaitObservation(
  child: Readonly<{
    childRunId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted';
    revision: number;
  }>,
  timeoutMs: number,
  timedOut: boolean,
  unchangedCursor?: string,
): Record<string, PortableValue> {
  const cursor = unchangedCursor ?? `subagent_wait.v1.${Buffer.from(JSON.stringify({
    id: child.childRunId,
    revision: child.revision,
  }), 'utf8').toString('base64url')}`;
  return {
    status: timedOut ? 'partial' : 'ok',
    summary: timedOut
      ? `Child ${child.childRunId} did not change before the wait timeout.`
      : `Child ${child.childRunId} is ${child.status}.`,
    child: {
      id: child.childRunId,
      status: child.status,
      revision: child.revision,
    },
    timeoutMs,
    cursor,
    timedOut,
  };
}

/** Windows filesystem identity is case-insensitive; source keys must share that identity. */
function canonicalUsageDatabasePath(filePath: string): string {
  const absolute = resolve(filePath);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentRuntimeError('INVALID_INPUT', `${name} must not be blank.`, false);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      `${name} must not exceed ${maxLength} characters.`,
      false,
    );
  }
  return normalized;
}

function deterministicSessionId(projectId: string, clientRequestId: string): string {
  const digest = createHash('sha256')
    .update(`${projectId}\0${clientRequestId}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function agentRunRequestDigest(
  input: AgentRunInput,
  identity: Readonly<{ sessionId: string; clientRequestId: string; message: string }>,
): string {
  const normalized = canonicalRequestValue({
    sessionId: identity.sessionId,
    clientRequestId: identity.clientRequestId,
    message: identity.message,
    model: input.model ?? null,
    sessionParameters: input.sessionParameters ?? null,
    generation: input.generation ?? null,
    sessionSkills: input.sessionSkills ?? null,
    systemPrompt: input.systemPrompt ?? null,
    capabilityInstructions: input.capabilityInstructions ?? null,
    allowedTools: input.allowedTools ?? null,
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function assertNoRunPermissionOverride(input: AgentRunInput): void {
  // TypeScript callers cannot supply this removed field.  Keep the runtime
  // boundary equally strict for JavaScript callers and deserialized IPC data:
  // global config.toml is the only permission-mode authority.
  if (Object.hasOwn(input, 'mode')) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      'Run permission overrides are not supported; configure permission_mode in global config.toml.',
      false,
    );
  }
}

function canonicalRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalRequestValue(entry)]));
}

function durableRolePrompt(prompt: AgentSystemPrompt): DurableRolePrompt {
  if (prompt.mode !== 'append' && prompt.mode !== 'replace') {
    throw new AgentRuntimeError('INVALID_INPUT', 'systemPrompt.mode must be append or replace.', false);
  }
  if (typeof prompt.content !== 'string' || prompt.content.length > MAX_MESSAGE_CHARS) {
    throw new AgentRuntimeError('INVALID_INPUT', 'systemPrompt.content is invalid.', false);
  }
  return Object.freeze({ mode: prompt.mode, content: prompt.content });
}

function durableRolePromptConfiguration(
  prompt: NonNullable<DurableRunConfiguration['rolePrompt']>,
): DurableRolePromptConfiguration {
  return Object.freeze({
    ...(prompt.default === undefined ? {} : { default: durableRolePrompt(prompt.default) }),
    ...(prompt.run === undefined ? {} : { run: durableRolePrompt(prompt.run) }),
  });
}

function compileRolePrompt(
  prompt: DurableRunConfiguration['rolePrompt'],
): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.run?.mode === 'replace') return prompt.run.content;
  const layers = [prompt.default?.content, prompt.run?.content]
    .filter((content): content is string => content !== undefined);
  return layers.length === 0 ? undefined : layers.join('\n\n');
}

function assertIngressSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw new AgentRuntimeError('ABORTED', 'Agent Run preparation was cancelled.', false);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeInstructionList(values: readonly string[] | undefined, name: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 100) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      `${name} must contain at most 100 strings.`,
      false,
    );
  }
  return values.map((value, index) => requireText(value, `${name}[${index}]`, 20_000));
}

function normalizeNameList(values: readonly string[] | undefined, name: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 2_000) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      `${name} must contain at most 2,000 tool names.`,
      false,
    );
  }
  return uniqueNames(
    values.map((value, index) => requireText(value, `${name}[${index}]`, MAX_IDENTIFIER_CHARS)),
  );
}

function normalizeOptionalNameList(
  values: readonly string[] | undefined,
  name: string,
): string[] | undefined {
  return values === undefined ? undefined : normalizeNameList(values, name);
}

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  if (error instanceof LlmProviderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function runtimeDriverFailureDetail(error: unknown) {
  if (error === null || typeof error !== 'object') {
    return { category: 'runtime-driver', causeCode: 'UNKNOWN' };
  }
  const candidate = 'code' in error ? error.code : undefined;
  return {
    category: 'runtime-driver',
    causeCode: typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate)
      ? candidate
      : 'UNKNOWN',
  };
}

function expectedCapabilityActivationError(error: unknown) {
  const message = error instanceof Error ? error.message.trim().slice(0, 2_048) : '';
  if (
    /Capability module is not available|Required capability is unavailable|Capability module is not registered/u.test(message)
  ) {
    return expectedToolError(
      'external',
      message ||
        'The selected capability is currently unavailable. Configure its external prerequisite and retry discovery.',
      { retryable: true },
    );
  }
  return undefined;
}

function publicControlError(error: unknown): unknown {
  if (error instanceof AgentRuntimeError) return error;
  const code = error instanceof AgentJournalError
    ? error.code
    : error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
  if (code === 'OUTCOME_RESOLUTION_CONFLICT') {
    return new AgentRuntimeError(
      'OUTCOME_RESOLUTION_CONFLICT', errorMessage(error), false,
    );
  }
  if (code === 'RISKY_RETRY_AUTHORIZATION_CONFLICT') {
    return new AgentRuntimeError(
      'RISKY_RETRY_AUTHORIZATION_CONFLICT', errorMessage(error), false,
    );
  }
  if (code === 'APPROVAL_DECISION_CONFLICT') {
    return new AgentRuntimeError(
      'APPROVAL_DECISION_CONFLICT', errorMessage(error), false,
    );
  }
  if (
    code === 'COMMAND_CONFLICT' || code === 'INVOCATION_STATE_CONFLICT' ||
    code === 'KERNEL_PROJECTION_INVALID'
  ) {
    return new AgentRuntimeError('RUN_STATE_INVALID', errorMessage(error), false);
  }
  return error;
}

function awaitAbortable<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(asError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(asError(error));
      },
    );
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** CapabilityControlPlane owner-qualifies its private Skill source IDs. */
function isCapabilitySkillSourceId(sourceId: string): boolean {
  return sourceId.startsWith('module:');
}

function internalContextProviderDeadline(options: AgentRuntimeOptions): number {
  const value = (options as AgentRuntimeOptions & { contextProviderHostDeadlineMs?: unknown })
    .contextProviderHostDeadlineMs;
  if (value === undefined) return CONTEXT_PROVIDER_HOST_DEADLINE_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new AgentRuntimeError(
      'INVALID_INPUT', 'contextProviderHostDeadlineMs must be a safe integer from 1 to 60,000.', false,
    );
  }
  return value;
}

function internalInitializationCloseDeadline(options: AgentRuntimeOptions): number {
  const value = (options as AgentRuntimeOptions & { initializationCloseDeadlineMs?: unknown })
    .initializationCloseDeadlineMs;
  if (value === undefined) return INITIALIZATION_CLOSE_DEADLINE_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      'initializationCloseDeadlineMs must be a safe integer from 1 to 60,000.',
      false,
    );
  }
  return value;
}

async function settleWithinDeadline(
  operations: readonly Promise<unknown>[],
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function runtimeProtocolSection() {
  const content = [
    'Use the captured capabilities and tools to complete the user request.',
    'Do not finish while a requested action or verification is still pending.',
    'Never use the final answer to announce work you intend to do next; perform that work with tools first.',
    'Treat a Tool result as evidence only for the action it actually reports, including unavailable or partial results.',
    'Use result_read for bounded inspection and result_materialize when a local Tool needs complete Runtime content; call result_save only when the user explicitly requests a persistent saved or exported file.',
    'Return a clear final answer that reports only completed work and observed verification results.',
  ].join(' ');
  return {
    id: 'schemanaut-runtime', source: 'runtime' as const, scope: 'static' as const,
    priority: 0, revision: 'schemanaut-runtime@2', cacheability: 'stable' as const,
    tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

function projectPromptSection(content: string) {
  return {
    id: 'schemanaut-project', source: 'project' as const, scope: 'run' as const,
    priority: 100, revision: 'project-current', cacheability: 'volatile' as const,
    tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

function userPromptSection(content: string) {
  return {
    id: 'schemanaut-user-role', source: 'user' as const, scope: 'session' as const,
    priority: 10, revision: 'user-role-current', cacheability: 'stable' as const,
    tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

/** @internal Deterministic prompt-section identity used by the Turn snapshot. */
export function skillCatalogPromptSection(skills: readonly SkillCatalogEntry[]) {
  const catalog = [...skills]
    .map(({ name, scope, description }) => ({ name, scope, description }))
    .sort((left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.name.localeCompare(right.name) ||
      left.description.localeCompare(right.description),
    );
  const content = [
    'Available Skills are optional workflows. Use the skill Tool to load one explicitly when useful.',
    ...catalog.map((skill) => `- ${skill.name} (${skill.scope}): ${skill.description}`),
  ].join('\n');
  const revision = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return {
    id: 'schemanaut-skill-catalog', source: 'capability' as const, scope: 'run' as const,
    priority: 40, revision: `skill-catalog:${revision}`,
    cacheability: 'volatile' as const, tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

/** Only the small bundled generic workflow catalog may enter an initial Turn. */
function boundedSystemSkillCatalog(registry: SkillRegistry): SkillCatalogEntry[] {
  const selected: SkillCatalogEntry[] = [];
  let characters = 0;
  for (const entry of registry.list({ scope: 'system' })) {
    const descriptor = registry.inspect({ name: entry.name, scope: entry.scope });
    if (descriptor?.sourceId !== 'schemanaut-system') continue;
    const remaining = MAX_INITIAL_SYSTEM_SKILL_CATALOG_CHARS - characters;
    if (remaining <= 0 || selected.length >= MAX_INITIAL_SYSTEM_SKILLS) break;
    const nameCost = entry.name.length + 8;
    if (nameCost >= remaining) break;
    const description = entry.description.slice(0, Math.max(0, remaining - nameCost));
    selected.push({ name: entry.name, scope: entry.scope, description });
    characters += nameCost + description.length;
  }
  return selected;
}

function capabilityPromptSection(content: string, index: number) {
  return {
    id: `schemanaut-capability-${index}`, source: 'capability' as const, scope: 'run' as const,
    priority: 50 + index, revision: `capability-guidance-${index}`,
    cacheability: 'stable' as const, tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

function skillPromptSection(id: string, revision: string, content: string) {
  return {
    id, source: 'skill' as const, scope: 'run' as const, priority: 80,
    revision, cacheability: 'stable' as const, tokenEstimate: Math.ceil(content.length / 4),
    content: [{ type: 'text' as const, text: content }],
  };
}

function createPermissionPolicyRevision(mode: AgentMode, globalRevision: string): string {
  return `permission:${mode}:global:${globalRevision}`;
}

function permissionMode(revision: string): AgentMode {
  const current = /^permission:(default|auto|full-access):global:/u.exec(revision)?.[1];
  if (current === 'default' || current === 'auto' || current === 'full-access') return current;
  const legacy = /^permission:(read|edit|full):v1$/u.exec(revision)?.[1];
  if (legacy === 'full') return 'full-access';
  return 'default';
}

function isTerminalKernelState(state: string): boolean {
  return ['Completed', 'Failed', 'Cancelled', 'LimitReached', 'Interrupted'].includes(state);
}

function subagentStatusForKernelState(state: string):
  'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted' | undefined {
  switch (state) {
    case 'Completed': return 'completed';
    case 'Failed': return 'failed';
    case 'Cancelled': return 'cancelled';
    case 'LimitReached': return 'limit_reached';
    case 'Interrupted': return 'interrupted';
    default: return undefined;
  }
}

function isRunDescendantOf(
  candidate: Readonly<{ runId: string; parentRunId: string | null }>,
  ancestorRunId: string,
  all: readonly Readonly<{ runId: string; parentRunId: string | null }>[],
): boolean {
  const parents = new Map(all.map((entry) => [entry.runId, entry.parentRunId] as const));
  let cursor = candidate.parentRunId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorRunId) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

function shouldDriveKernelState(state: string): boolean {
  return ![
    'AwaitingUser', 'Completed', 'Failed', 'Cancelled', 'LimitReached', 'Interrupted',
  ].includes(state);
}

function kernelResultStatus(state: string): DurableAgentRunResult['status'] {
  switch (state) {
    case 'Completed': return 'completed';
    case 'Cancelled': return 'cancelled';
    case 'LimitReached': return 'limit_reached';
    case 'Interrupted': return 'interrupted';
    default: return 'failed';
  }
}
