import { describe, expect, it } from 'vitest';
import { createAgentTaskPlan, verifyAgentCompletion } from '../src/index.js';

describe('Agent completion verification', () => {
  it('accepts a delivered database result only with a terminal final response', () => {
    const verification = verifyAgentCompletion({
      toolExecutions: [
        {
          toolCallId: 'sql-1',
          toolName: 'sql_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"returnedRowCount":3}',
          completionEvidence: {
            kind: 'database-result',
            deliveryReady: true,
          },
        },
      ],
      proposedFinalText: 'Let me verify the result before I answer.',
    });

    expect(verification).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: false,
      phase: 'finalize',
      evidenceKinds: ['database-result'],
    });
  });

  it('rejects a failed SQL attempt and keeps simple non-tool answers valid', () => {
    expect(
      verifyAgentCompletion({
        toolExecutions: [
          {
            toolCallId: 'sql-1',
            toolName: 'sql_execute',
            status: 'failed',
            durationMs: 1,
            resultPreview: 'syntax error',
          },
        ],
        proposedFinalText: 'Done.',
      }),
    ).toMatchObject({
      verified: false,
      deliveryReady: false,
      phase: 'verify',
      missing: ['the latest SQL execution did not succeed'],
    });

    expect(
      verifyAgentCompletion({
        toolExecutions: [],
        proposedFinalText: 'A CTE is a named query expression.',
      }),
    ).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'finalize',
    });
  });

  it('requires the latest SQL execution to be successful and deliverable', () => {
    const verification = verifyAgentCompletion({
      toolExecutions: [
        {
          toolCallId: 'sql-success',
          toolName: 'sql_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"rowCount":1}',
          completionEvidence: {
            kind: 'database-result',
            deliveryReady: true,
          },
        },
        {
          toolCallId: 'sql-final-failure',
          toolName: 'sql_execute',
          status: 'failed',
          durationMs: 1,
          resultPreview: 'statement timeout',
        },
      ],
      proposedFinalText: 'The query is complete.',
    });

    expect(verification).toMatchObject({
      verified: false,
      deliveryReady: false,
      phase: 'verify',
      missing: ['the latest SQL execution did not succeed'],
    });
  });

  it('accepts a denied or failed SQL outcome only when the final response explicitly delivers it', () => {
    expect(
      verifyAgentCompletion({
        toolExecutions: [
          {
            toolCallId: 'sql-denied',
            toolName: 'sql_execute',
            status: 'denied',
            durationMs: 1,
            resultPreview: 'Approval was denied.',
          },
        ],
        proposedFinalText: '本次修改未获批准，因此没有执行。',
      }),
    ).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'finalize',
    });

    expect(
      verifyAgentCompletion({
        toolExecutions: [
          {
            toolCallId: 'sql-timeout',
            toolName: 'sql_execute',
            status: 'failed',
            durationMs: 100,
            resultPreview: 'statement timeout',
          },
        ],
        proposedFinalText: '查询已超时并取消，没有继续等待。',
      }),
    ).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'finalize',
    });
  });

  it('treats the model plan as guidance rather than runtime completion evidence', () => {
    const taskPlan = createAgentTaskPlan({
      goal: 'Inspect and report',
      tasks: [
        { id: 'inspect', title: 'Inspect schema' },
        { id: 'answer', title: 'Answer the user' },
      ],
      now: '2026-07-31T00:00:00.000Z',
    });

    const verification = verifyAgentCompletion({
      taskPlan,
      toolExecutions: [
        {
          toolCallId: 'sql-1',
          toolName: 'sql_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"returnedRowCount":7}',
          completionEvidence: {
            kind: 'database-result',
            deliveryReady: true,
          },
        },
      ],
      proposedFinalText: 'The database contains seven schemas.',
    });

    expect(verification).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      unresolvedTaskIds: [],
      missing: [],
    });
  });
});
