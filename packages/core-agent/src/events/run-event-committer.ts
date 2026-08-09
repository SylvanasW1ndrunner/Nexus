import { createHash } from 'node:crypto';
import type {
  ModelContentBlock,
  ModelProtocolEnvelope,
  ValidatedModelAttempt,
} from '@dbagent/core-llm';
import { assertAuthenticValidatedModelAttempt } from '@dbagent/core-llm';
import { assertNoSecretMaterial, assertPortableValue, type PortableValue } from '@dbagent/shared';
import { AgentJournalError, type RunLeaseReference } from './agent-journal.js';
import type { AgentInvocationProjection, AgentTurnProjection } from './event-projectors.js';
import {
  commitPreparedModelAttemptCapability,
  type SqliteAgentJournal,
} from './sqlite-agent-journal.js';

export type CommitValidatedAttemptCommand = {
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
  expectedTurnRevision: number;
  attempt: ValidatedModelAttempt;
};

export type ModelTurnCommitResult = {
  turn: AgentTurnProjection;
  envelope: ModelProtocolEnvelope;
  invocations: AgentInvocationProjection[];
};

export type PreparedModelTurnCommit = ModelTurnCommitResult;

export class RunEventCommitter {
  constructor(private readonly journal: SqliteAgentJournal) {}

  async commitValidatedAttempt(
    command: CommitValidatedAttemptCommand,
  ): Promise<ModelTurnCommitResult> {
    const prepared = prepareValidatedAttempt(command);
    return await this.journal[commitPreparedModelAttemptCapability](command, prepared);
  }
}

function prepareValidatedAttempt(command: CommitValidatedAttemptCommand): PreparedModelTurnCommit {
  const { attempt } = command;
  try {
    assertAuthenticValidatedModelAttempt(attempt);
  } catch {
    throw new AgentJournalError(
      'ATTEMPT_NOT_VALIDATED',
      'RunEventCommitter accepts only an authentic terminal ValidatedModelAttempt.',
    );
  }
  try {
    assertPortableValue(attempt);
    assertNoSecretMaterial(attempt);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      `Validated model attempt is not safe portable data: ${errorMessage(error)}`,
    );
  }

  const actualOpaqueRefs = attempt.blocks.flatMap((block) =>
    block.type === 'provider-opaque' ? [block.opaqueRef] : [],
  );
  if (canonicalJson(actualOpaqueRefs) !== canonicalJson(attempt.opaqueBlockRefs)) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      'Validated attempt opaqueBlockRefs do not match its ordered opaque blocks.',
    );
  }

  const correlations: ModelProtocolEnvelope['correlations'] = [];
  const invocations: AgentInvocationProjection[] = [];
  const blocks: ModelContentBlock[] = [];
  const draftKeys = new Set<string>();
  let actionOrdinal = 0;
  const committedAt = new Date(0).toISOString();
  for (const block of attempt.blocks) {
    if (block.type !== 'tool-call-draft') {
      blocks.push(structuredClone(block));
      continue;
    }
    if (draftKeys.has(block.draftCallKey)) {
      throw new AgentJournalError('INVALID_EVENT_PAYLOAD', 'Tool draftCallKey must be unique.');
    }
    draftKeys.add(block.draftCallKey);
    const callId = stableIdentity('call', command.runId, command.turnId, actionOrdinal);
    const invocationId = stableIdentity('invocation', command.runId, command.turnId, actionOrdinal);
    blocks.push({
      type: 'tool-call',
      callId,
      name: block.name,
      arguments: structuredClone(block.arguments),
    });
    correlations.push({
      callId,
      draftCallKey: block.draftCallKey,
      ...(block.wireIdentity === undefined
        ? {}
        : { wireIdentity: structuredClone(block.wireIdentity) }),
      replay: 'same-connection-only',
    });
    invocations.push({
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      attemptId: attempt.attemptId,
      invocationId,
      callId,
      actionOrdinal,
      name: block.name,
      arguments: structuredClone(block.arguments),
      state: 'proposed',
      revision: 1,
      createdAt: committedAt,
    });
    actionOrdinal += 1;
  }

  const envelope: ModelProtocolEnvelope = {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    origin: structuredClone(attempt.origin),
    correlations,
    opaqueBlockRefs: [...attempt.opaqueBlockRefs],
  };
  const turn: AgentTurnProjection = {
    projectId: command.projectId,
    sessionId: command.sessionId,
    runId: command.runId,
    turnId: command.turnId,
    attemptId: attempt.attemptId,
    blocks,
    finishReason: attempt.finishReason ?? 'unknown',
    ...(attempt.usage === undefined ? {} : { usage: structuredClone(attempt.usage) }),
    protocolEnvelopeRef: `protocol-envelope:${command.turnId}`,
    committedAt,
  };
  return { turn, envelope, invocations };
}

function stableIdentity(
  prefix: 'call' | 'invocation',
  runId: string,
  turnId: string,
  actionOrdinal: number,
): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${turnId}\0${actionOrdinal}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as PortableValue)}`)
    .join(',')}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
