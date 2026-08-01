import { describe, expect, it } from 'vitest';
import { createAgentTaskPlan, verifyAgentCompletion } from '../src/index.js';

describe('Agent completion verification', () => {
  it('accepts deliverable evidence but rejects a process-only final response', () => {
    const verification = verifyAgentCompletion({
      toolExecutions: [
        {
          toolCallId: 'query-1',
          toolName: 'database_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"returnedRowCount":3}',
          completionRole: 'deliverable',
          completionGroup: 'database-execution',
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

  it('rejects references to hidden earlier output as a final delivery', () => {
    for (const proposedFinalText of [
      '查询已完成，统计结果已如上表呈现。',
      'The query completed and the results are shown above.',
    ]) {
      expect(
        verifyAgentCompletion({
          toolExecutions: [
            {
              toolCallId: 'query-reference-only',
              toolName: 'database_execute',
              status: 'success',
              durationMs: 1,
              resultPreview: '{"returnedRowCount":9}',
              completionRole: 'deliverable',
              completionEvidence: {
                kind: 'database-result',
                deliveryReady: true,
              },
            },
          ],
          proposedFinalText,
        }),
      ).toMatchObject({
        verified: true,
        deliveryReady: true,
        finalResponseReady: false,
        phase: 'finalize',
      });
    }
  });

  it('rejects a failed deliverable action and keeps simple non-tool answers valid', () => {
    expect(
      verifyAgentCompletion({
        toolExecutions: [
          {
            toolCallId: 'file-1',
            toolName: 'file_write',
            status: 'failed',
            durationMs: 1,
            resultPreview: 'disk full',
            completionRole: 'deliverable',
            completionGroup: 'artifact-write',
          },
        ],
        proposedFinalText: 'Done.',
      }),
    ).toMatchObject({
      verified: false,
      deliveryReady: false,
      phase: 'verify',
      missing: ['the latest deliverable action did not succeed'],
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

  it('requires the latest deliverable action to be successful and deliverable', () => {
    const verification = verifyAgentCompletion({
      toolExecutions: [
        {
          toolCallId: 'query-success',
          toolName: 'database_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"rowCount":1}',
          completionRole: 'deliverable',
          completionEvidence: {
            kind: 'database-result',
            deliveryReady: true,
          },
        },
        {
          toolCallId: 'query-final-failure',
          toolName: 'database_execute',
          status: 'failed',
          durationMs: 1,
          resultPreview: 'statement timeout',
          completionRole: 'deliverable',
        },
      ],
      proposedFinalText: 'The query is complete.',
    });

    expect(verification).toMatchObject({
      verified: false,
      deliveryReady: false,
      phase: 'verify',
      missing: ['the latest deliverable action did not succeed'],
    });
  });

  it('accepts a denied or failed deliverable only when the final response delivers it', () => {
    expect(
      verifyAgentCompletion({
        toolExecutions: [
          {
            toolCallId: 'write-denied',
            toolName: 'file_write',
            status: 'denied',
            durationMs: 1,
            resultPreview: 'Approval was denied.',
            completionRole: 'deliverable',
          },
        ],
        proposedFinalText: '本次写入未获批准，因此没有执行。',
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
            toolCallId: 'process-timeout',
            toolName: 'process_wait',
            status: 'failed',
            durationMs: 100,
            resultPreview: 'process timeout',
            completionRole: 'deliverable',
          },
        ],
        proposedFinalText: '任务已超时并取消，没有继续等待。',
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
          toolCallId: 'query-1',
          toolName: 'database_execute',
          status: 'success',
          durationMs: 1,
          resultPreview: '{"returnedRowCount":7}',
          completionRole: 'deliverable',
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
