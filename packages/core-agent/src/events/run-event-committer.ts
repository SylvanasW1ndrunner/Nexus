import type { ModelProtocolEnvelope, ValidatedModelAttempt } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { RunLeaseReference } from './agent-journal.js';
import type { AgentInvocationProjection, AgentTurnProjection } from './event-projectors.js';
import type { SqliteAgentJournal } from './sqlite-agent-journal.js';

export type CommitValidatedAttemptCommand = {
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
  expectedTurnRevision: number;
  billingMode: UsageMode;
  attempt: ValidatedModelAttempt;
};

export type ModelTurnCommitResult = {
  turn: AgentTurnProjection;
  envelope: ModelProtocolEnvelope;
  invocations: AgentInvocationProjection[];
};

export class RunEventCommitter {
  constructor(private readonly journal: SqliteAgentJournal) {}

  async commitValidatedAttempt(
    command: CommitValidatedAttemptCommand,
  ): Promise<ModelTurnCommitResult> {
    return await this.journal.commitValidatedAttempt(command);
  }
}
