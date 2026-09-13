import { describe, expect, it } from 'vitest';
import type { AuditProjectionEvent } from '@dbagent/core-agent';
import {
  runAgentEvaluationSuite,
  type AgentEvalCaseExecution,
  type AgentEvalSuiteAgent,
} from '../src/index.js';

const SCHEMA_EVIDENCE = 'schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUERY_EVIDENCE = 'schemanaut-evidence:v1:artifact_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const OTHER_EVIDENCE = 'schemanaut-evidence:v1:artifact_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

describe('runAgentEvaluationSuite', () => {
  it('evaluates an exact Run result against Audit facts, not a second Agent loop', async () => {
    const agent = recordingAgent([execution('completed', [
      event(1, 'turn.started', {}),
      event(2, 'tool.proposed', {
        invocationId: 'invoke-schema', callId: 'call-schema', actionOrdinal: 0,
        name: 'search_schema', arguments: { query: 'GMV' },
      }, { invocationId: 'invoke-schema' }),
      event(3, 'tool.succeeded', {
        summary: 'Schema found.', resultRefs: [SCHEMA_EVIDENCE],
      }, { invocationId: 'invoke-schema' }),
      event(4, 'run.completed', {
        finalContentRef: 'turn:turn-1:content', deliveryStatus: 'verified',
        evidenceRefs: [SCHEMA_EVIDENCE],
      }),
    ], 'paid_search GMV is ready.', [SCHEMA_EVIDENCE])]);

    const output = await runAgentEvaluationSuite({
      agent,
      generatedAt: '2026-09-04T00:00:00.000Z',
      baseConfiguration: { mode: 'default', allowedTools: ['search_schema'] },
      suite: {
        suiteId: 'schema-eval',
        suiteName: 'Schema retrieval',
        environment: 'integration',
        cases: [{
          expectation: {
            id: 'EVAL-001', userTask: 'Find the GMV source.', expectedStatus: 'completed',
            requiredToolCalls: ['search_schema'],
            requiredToolStatuses: [{ toolName: 'search_schema', status: 'success' }],
            toolExpectations: [{
              toolName: 'search_schema', status: 'success', minCalls: 1, maxCalls: 1,
              argumentIncludes: ['GMV'], resultIncludes: ['Schema found'],
            }],
            finalTextIncludes: ['paid_search'], minTurns: 1, maxTurns: 1,
          },
          configuration: { allowedTools: ['search_schema'] },
        }],
      },
    });

    expect(output.summary).toEqual({ totalCases: 1, passedCases: 1, failedCases: 0, passRate: 1 });
    expect(output.report).toMatchObject({
      schemaVersion: 1, generatedAt: '2026-09-04T00:00:00.000Z', environment: 'integration',
    });
    expect(output.caseResults[0]?.observed).toMatchObject({
      turnCount: 1,
      tools: [{ toolName: 'search_schema', status: 'success', evidenceRefs: [SCHEMA_EVIDENCE] }],
    });
    expect(agent.calls).toEqual([{
      caseId: 'EVAL-001', userTask: 'Find the GMV source.',
      configuration: { mode: 'default', allowedTools: ['search_schema'] },
    }]);
  });

  it('stops only after a failed evidence-backed case when requested', async () => {
    const agent = recordingAgent([
      execution('completed', [event(1, 'run.completed', {
        finalContentRef: 'turn:turn-1:content', deliveryStatus: 'not-required', evidenceRefs: [],
      })], 'No tool was needed.'),
      execution('completed', [event(1, 'run.completed', {
        finalContentRef: 'turn:turn-2:content', deliveryStatus: 'not-required', evidenceRefs: [],
      })], 'The second case must not run.'),
    ]);

    const output = await runAgentEvaluationSuite({
      agent,
      stopOnFirstFailure: true,
      suite: {
        suiteId: 'stop', suiteName: 'stop', cases: [
          { expectation: {
            id: 'FAIL-001', userTask: 'Must use the database.', requiredToolCalls: ['query_database'],
          } },
          { expectation: { id: 'FAIL-002', userTask: 'Second task.' } },
        ],
      },
    });

    expect(output.summary).toEqual({ totalCases: 1, passedCases: 0, failedCases: 1, passRate: 0 });
    expect(output.caseResults[0]?.failures).toContain('Required Tool query_database was not proposed.');
    expect(agent.calls).toHaveLength(1);
  });

  it('rejects audit input that crosses an evaluated Run boundary', async () => {
    const agent = recordingAgent([execution('completed', [event(1, 'run.completed', {
      finalContentRef: 'turn:turn-1:content', deliveryStatus: 'not-required', evidenceRefs: [],
    }, { runId: 'another-run' })], 'Done.')]);

    await expect(runAgentEvaluationSuite({
      agent,
      suite: { suiteId: 'bad', suiteName: 'bad', cases: [{ expectation: {
        id: 'BAD-001', userTask: 'Bad audit.',
      } }] },
    })).rejects.toThrow('Agent eval audit crossed the evaluated Run or Session boundary.');
  });

  it('matches arguments and result summaries independently with an explicit case rule', async () => {
    const agent = recordingAgent([execution('completed', [
      event(1, 'tool.proposed', {
        invocationId: 'invoke-query', callId: 'call-query', actionOrdinal: 0,
        name: 'query_database', arguments: { sql: 'SELECT * FROM SALES' },
      }, { invocationId: 'invoke-query' }),
      event(2, 'tool.succeeded', {
        summary: 'Paid_Search returned.', resultRefs: [QUERY_EVIDENCE],
      }, { invocationId: 'invoke-query' }),
      event(3, 'run.completed', {
        finalContentRef: 'turn:turn-1:content', deliveryStatus: 'verified',
        evidenceRefs: [QUERY_EVIDENCE],
      }),
    ], 'Done.', [QUERY_EVIDENCE])]);

    const output = await runAgentEvaluationSuite({
      agent,
      suite: { suiteId: 'case', suiteName: 'case', cases: [{ expectation: {
        id: 'CASE-001', userTask: 'Query sales.', toolExpectations: [{
          toolName: 'query_database', caseSensitive: false,
          argumentIncludes: ['select * from sales'], resultIncludes: ['paid_search'],
          resultExcludes: ['select * from sales'],
        }],
      } }] },
    });

    expect(output.caseResults[0]?.passed).toBe(true);
  });

  it('rejects an execution whose public result cites different evidence than the journal completion', async () => {
    const agent = recordingAgent([execution('completed', [event(1, 'run.completed', {
      finalContentRef: 'turn:turn-1:content', deliveryStatus: 'verified', evidenceRefs: [SCHEMA_EVIDENCE],
    })], 'Done.', [OTHER_EVIDENCE])]);

    await expect(runAgentEvaluationSuite({
      agent,
      suite: { suiteId: 'evidence', suiteName: 'evidence', cases: [{ expectation: {
        id: 'EVIDENCE-001', userTask: 'Check evidence.',
      } }] },
    })).rejects.toThrow('Agent eval result evidence does not match the committed Run completion fact.');
  });

  it('rejects an empty suite before invoking the evaluator port', async () => {
    const agent = recordingAgent([]);
    await expect(runAgentEvaluationSuite({
      agent,
      suite: { suiteId: 'empty', suiteName: 'empty', cases: [] },
    })).rejects.toThrow('Agent eval suite must contain at least one case.');
    expect(agent.calls).toEqual([]);
  });
});

function recordingAgent(
  script: AgentEvalCaseExecution[],
): AgentEvalSuiteAgent & { calls: Array<Parameters<AgentEvalSuiteAgent['run']>[0]> } {
  const calls: Array<Parameters<AgentEvalSuiteAgent['run']>[0]> = [];
  return {
    calls,
    run(input) {
      calls.push(input);
      const next = script.shift();
      if (next === undefined) throw new Error('No scripted Agent result left.');
      return Promise.resolve(next);
    },
  };
}

function execution(
  status: AgentEvalCaseExecution['result']['status'],
  audit: AuditProjectionEvent[],
  finalText: string,
  evidenceRefs: readonly string[] = [],
): AgentEvalCaseExecution {
  return {
    result: {
      runId: 'run-eval', sessionId: 'session-eval', status, finalText, evidenceRefs,
    },
    audit,
  };
}

function event(
  sourceSequence: number,
  type: AuditProjectionEvent['type'],
  payload: unknown,
  identity: Partial<Pick<AuditProjectionEvent, 'runId' | 'sessionId' | 'invocationId'>> = {},
): AuditProjectionEvent {
  return {
    sourceSequence,
    eventId: `event-${sourceSequence}`,
    projectId: 'project-eval',
    sessionId: identity.sessionId ?? 'session-eval',
    runId: identity.runId ?? 'run-eval',
    type,
    occurredAt: `2026-09-04T00:00:0${sourceSequence}.000Z`,
    payload: payload as AuditProjectionEvent['payload'],
    ...(identity.invocationId === undefined ? {} : { invocationId: identity.invocationId }),
  };
}
