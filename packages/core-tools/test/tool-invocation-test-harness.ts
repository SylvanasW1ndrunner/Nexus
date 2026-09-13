import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionManager,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolRegistry,
  type AgentCapabilityDiscoveryManifestEntry,
  type RunLease,
} from '@dbagent/core-agent';
import { ToolInvocationRuntime } from '../../core-agent/dist/tools/tool-invocation-runtime.js';
import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelRouteSnapshotInput,
} from '@dbagent/core-llm';
import { SkillRegistry } from '@dbagent/core-skills';
import {
  createAskUserToolContribution,
  createProcessToolContributions,
  createResultMaterializeToolContribution,
  createResultReadToolContribution,
  createResultSaveToolContribution,
  createSkillToolContribution,
  createToolSearchToolContribution,
  createWebToolGeneration,
  createWorkspaceToolGeneration,
  ProcessRuntime,
  type ToolSearchCapabilityActivator,
  type WebToolOptions,
} from '../src/index.js';

export async function createBaselineTestRegistry(options: Readonly<{
  rootPath?: string;
  skills?: SkillRegistry;
  processRuntime?: ProcessRuntime;
  web?: WebToolOptions;
  capabilityActivator?: ToolSearchCapabilityActivator;
}> = {}) {
  const ownedRoot = options.rootPath === undefined ? await mkdtemp(join(tmpdir(), 'schemanaut-baseline-')) : undefined;
  const rootPath = options.rootPath ?? ownedRoot!;
  const ownedRuntime = options.processRuntime === undefined
    ? new ProcessRuntime({ spoolDirectory: join(rootPath, '.baseline-spool'), hostId: 'local' })
    : undefined;
  const runtime = options.processRuntime ?? ownedRuntime!;
  const workspace = createWorkspaceToolGeneration({ rootPath });
  const web = createWebToolGeneration(options.web ?? {});
  const registry = new ToolRegistry();
  registry.publishBaselineInvocations([
    createAskUserToolContribution({ interactive: false }),
    createToolSearchToolContribution({
      ...(options.capabilityActivator === undefined
        ? {}
        : { capabilityActivator: options.capabilityActivator }),
    }),
    createResultReadToolContribution({}),
    createResultMaterializeToolContribution({}),
    createResultSaveToolContribution({ rootPath }),
    createSkillToolContribution(options.skills ?? new SkillRegistry()),
    ...workspace.contributions,
    ...createProcessToolContributions({ rootPath, runtime }),
    ...web.contributions,
  ]);
  return {
    registry, runtime,
    dispose: async () => {
      await workspace.drain();
      if (ownedRuntime !== undefined) await ownedRuntime.close();
      if (ownedRoot !== undefined) await rm(ownedRoot, { recursive: true, force: true });
    },
  };
}

export type TestToolCall = Readonly<{
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type ExecuteInvocationToolsOptions = Readonly<{
  sessionId?: string;
  signal?: AbortSignal;
  discoverableCapabilities?: readonly AgentCapabilityDiscoveryManifestEntry[];
  continuation?: Readonly<{
    directory: string;
    journal: SqliteAgentJournal;
    runId: string;
    lease: RunLease;
  }>;
}>;

export async function executeInvocationTools(
  registry: ToolRegistry,
  calls: readonly TestToolCall[],
  options: ExecuteInvocationToolsOptions = {},
) {
  const sessionId = options.sessionId ?? 'session-tools';
  const directory = options.continuation?.directory ?? await mkdtemp(join(tmpdir(), 'schemanaut-core-tools-'));
  const journal = options.continuation?.journal ?? new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
  const created = options.continuation === undefined
    ? await journal.createRun({
      projectId: 'project-tools',
      sessionId,
      clientRequestId: `request-${sessionId}-${calls.map(({ name }) => name).join('-')}`,
      input: 'test runtime controls',
    })
    : undefined;
  const runId = options.continuation?.runId ?? created!.runId;
  const lease = options.continuation?.lease ?? await journal.acquireRunLease({
    projectId: 'project-tools', runId, ownerId: 'test-worker', ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  if (options.continuation === undefined) {
    await journal.startRun({
      projectId: 'project-tools', sessionId, runId,
      commandId: 'start-run', lease: leaseRef, expectedRunRevision: 1,
    });
  }
  const run = await journal.getRunProjection(runId);
  if (run === null) throw new Error('Test run is missing.');
  const turnId = `turn-tools-${run.revision}`;
  await journal.startTurn({
    projectId: 'project-tools', sessionId, runId,
    turnId, commandId: `start-turn-${run.revision}`, lease: leaseRef, expectedRunRevision: run.revision,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-tools', sessionId, runId,
    turnId, commandId: `commit-attempt-${run.revision}`, lease: leaseRef,
    expectedRunRevision: run.revision + 1, expectedTurnRevision: 1,
    billingMode: 'byok',
    attempt: await attemptFor(calls, turnId),
  });
  const snapshot = registry.captureSnapshot();
  const runtime = new ToolInvocationRuntime({
    journal,
    registry: snapshot,
    allowedTools: snapshot.list().flatMap(({ name }) => {
      const revision = snapshot.invocationRevision(name);
      return revision === undefined ? [] : [{ name, revision }];
    }),
    ...(options.discoverableCapabilities === undefined
      ? {}
      : { discoverableCapabilities: options.discoverableCapabilities }),
    // Capability discovery is committed by the Runtime before its host bridge
    // activates the selected module. This focused Tool fixture has no host, so
    // it deliberately models only that post-commit boundary.
    runtimeCommandExecutor: () => Promise.resolve(undefined),
    permissionManager: new PermissionManager(),
    binding: {
      projectId: 'project-tools', sessionId, runId,
      turnId, lease, mode: 'full-access',
    },
  });
  const observations = await runtime.executeEligible(
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return {
    directory,
    journal,
    runId,
    lease,
    observations,
    invocations: committed.invocations,
    dispose: async () => await rm(directory, { recursive: true, force: true }),
  };
}

async function attemptFor(calls: readonly TestToolCall[], turnId: string) {
  const response = {
    id: `response-core-tools-${turnId}`,
    model: 'model-core-tools',
    status: 'completed',
    output: calls.map((call, index) => ({
      id: `item-${index}`,
      type: 'function_call',
      call_id: `wire-${index}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const client: ModelClient = { execute: () => Promise.resolve({ kind: 'json', response }) };
  const route: ModelRouteSnapshotInput = {
    routeId: 'core-tools-route', connectionId: 'core-tools-connection',
    providerId: 'core-tools-provider', modelId: 'model-core-tools',
    protocol: 'openai-responses', codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'core-tools-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec(route.protocol, route.codecRevision);
  if (codec === undefined) throw new Error('Missing Responses codec.');
  const session = createModelSession({ route, generation: {}, codec, client });
  const request: CanonicalModelRequest = {
    model: route.modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  };
  return (await new ModelExecutionGateway({ createAttemptId: () => `attempt-core-tools-${turnId}` })
    .executeAttempt(session, request)).attempt;
}
