import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionManager,
  ProjectArtifactStore,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolInvocationRuntime,
  type AgentMode,
  type ToolCatalogSnapshot,
  type ToolRegistry,
} from '@dbagent/core-agent';
import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelRouteSnapshotInput,
} from '@dbagent/core-llm';

type RuntimeApprovalDecision = Parameters<ToolInvocationRuntime['decideApproval']>[0];

export async function executeAiSqlInvocations(
  registry: ToolRegistry,
  calls: readonly Readonly<{
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }>[],
  options: Readonly<{
    sessionId?: string;
    mode?: AgentMode;
    approvalDecision?: 'approve' | 'deny';
  }> = {},
) {
  return await executeAiSqlSnapshotInvocations(registry.captureSnapshot(), calls, options);
}

export async function executeAiSqlSnapshotInvocations(
  snapshot: ToolCatalogSnapshot,
  calls: readonly Readonly<{
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }>[],
  options: Readonly<{
    sessionId?: string;
    mode?: AgentMode;
    approvalDecision?: 'approve' | 'deny';
  }> = {},
) {
  const sessionId = options.sessionId ?? 'session-ai-sql';
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-ai-sql-invocation-'));
  const journalPath = join(directory, 'state.db');
  const journal = new SqliteAgentJournal({ filePath: journalPath });
  const artifactStore = new ProjectArtifactStore({
    projectId: 'project-ai-sql',
    rootDir: join(directory, 'artifacts'),
    journal,
  });
  const created = await journal.createRun({
    projectId: 'project-ai-sql',
    sessionId,
    clientRequestId: `request-${sessionId}-${calls.map(({ name }) => name).join('-')}`,
    input: 'test AI SQL Invocation runtime',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-ai-sql',
    runId: created.runId,
    ownerId: 'test-worker',
    ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-ai-sql', sessionId, runId: created.runId,
    commandId: 'start-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-ai-sql', sessionId, runId: created.runId,
    turnId: 'turn-ai-sql', commandId: 'start-turn', lease: leaseRef, expectedRunRevision: 2,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-ai-sql', sessionId, runId: created.runId,
    turnId: 'turn-ai-sql', commandId: 'commit-attempt', lease: leaseRef,
    expectedRunRevision: 3, expectedTurnRevision: 1,
    billingMode: 'byok',
    attempt: await attemptFor(calls),
  });
  const runtime = new ToolInvocationRuntime({
    journal,
    registry: snapshot,
    allowedTools: snapshot.list().flatMap(({ name }) => {
      const revision = snapshot.invocationRevision(name);
      return revision === undefined ? [] : [{ name, revision }];
    }),
    permissionManager: new PermissionManager(),
    artifactStore,
    revalidateTarget: () => undefined,
    binding: {
      projectId: 'project-ai-sql', sessionId, runId: created.runId,
      turnId: 'turn-ai-sql', lease, mode: options.mode ?? 'full-access',
    },
  });
  const observations = [...await runtime.executeEligible()];
  const approvals = [];
  for (const invocation of committed.invocations) {
    const approval = await journal.getApproval({
      projectId: 'project-ai-sql', sessionId, runId: created.runId, invocationId: invocation.invocationId,
    });
    if (approval?.status !== 'pending') continue;
    approvals.push(approval);
    if (options.approvalDecision !== undefined) {
      const decision: RuntimeApprovalDecision = {
        commandId: `decision-${approval.approvalId}-${options.approvalDecision}`,
        approvalId: approval.approvalId,
        projectId: approval.projectId,
        sessionId: approval.sessionId,
        runId: approval.runId,
        turnId: approval.turnId,
        invocationId: approval.invocationId,
        canonicalToolId: approval.canonicalToolId,
        toolRevision: approval.toolRevision,
        recoveryClass: approval.recoveryClass,
        intentDigest: approval.intentDigest,
        proposedRevision: approval.proposedRevision,
        decision: options.approvalDecision,
      };
      await runtime.decideApproval(decision);
      if (options.approvalDecision === 'approve') {
        const observation = await runtime.execute(invocation.invocationId);
        if (observation !== undefined) observations.push(observation);
      }
    }
  }
  const invocations = (await Promise.all(
    committed.invocations.map(({ invocationId }) => journal.getInvocation(invocationId)),
  )).filter((invocation): invocation is NonNullable<typeof invocation> => invocation !== null);
  return {
    directory,
    journal,
    journalPath,
    artifactStore,
    projectId: 'project-ai-sql',
    sessionId,
    runId: created.runId,
    observations,
    approvals,
    invocations,
    dispose: async () => {
      snapshot.release();
      await artifactStore.drain?.();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function attemptFor(calls: readonly Readonly<{
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}>[]) {
  const response = {
    id: 'response-ai-sql',
    model: 'model-ai-sql',
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
    routeId: 'ai-sql-route', connectionId: 'ai-sql-connection',
    providerId: 'ai-sql-provider', modelId: 'model-ai-sql',
    protocol: 'openai-responses', codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'ai-sql-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec(route.protocol, route.codecRevision);
  if (codec === undefined) throw new Error('Missing Responses codec.');
  const session = createModelSession({ route, generation: {}, codec, client });
  const request: CanonicalModelRequest = {
    model: route.modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  };
  return (await new ModelExecutionGateway({ createAttemptId: () => 'attempt-ai-sql' })
    .executeAttempt(session, request)).attempt;
}
