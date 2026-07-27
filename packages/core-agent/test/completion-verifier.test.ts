import { describe, expect, it } from 'vitest';
import { verifyAgentCompletion } from '../src/index.js';

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
});
