import { describe, expect, it } from 'vitest';
import { parseAgentEvalSuiteManifest, parseAgentEvalSuiteManifestJson } from '../src/index.js';

describe('Agent eval suite manifest parser', () => {
  it('parses a workspace or official-plugin suite manifest into a runnable suite contract', () => {
    const suite = parseAgentEvalSuiteManifest({
      version: 1,
      suite: {
        suiteId: 'agent-rag-workspace-eval',
        suiteName: 'Agent/RAG 工作区验收',
        environment: 'postgres',
        notes: ['从工作区 manifest 加载，不包含 provider、model 或 secret。'],
        cases: [
          {
            id: 'WORKSPACE-EVAL-001',
            userTask: '按渠道统计 GMV 和 ROI。',
            expectedStatus: 'done',
            requiredToolCalls: ['search_schema', 'query_database'],
            requiredToolStatuses: [
              { toolName: 'search_schema', status: 'success' },
              { toolName: 'query_database', status: 'success' },
            ],
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'success',
                minCalls: 1,
                maxCalls: 1,
                caseSensitive: false,
                argumentIncludes: ['select', 'from analytics.traffic_sessions'],
                resultIncludes: ['paid_search'],
              },
            ],
            finalTextIncludes: ['GMV'],
            finalTextExcludes: ['password', 'apiKey'],
            minIterations: 2,
            maxIterations: 5,
            run: {
              allowedTools: ['search_schema', 'query_database'],
              mode: 'readonly',
              maxIterations: 5,
              maxToolExecutionMs: 10_000,
            },
          },
        ],
      },
    });

    expect(suite).toMatchObject({
      suiteId: 'agent-rag-workspace-eval',
      suiteName: 'Agent/RAG 工作区验收',
      environment: 'postgres',
      notes: ['从工作区 manifest 加载，不包含 provider、model 或 secret。'],
      cases: [
        {
          case: {
            id: 'WORKSPACE-EVAL-001',
            userTask: '按渠道统计 GMV 和 ROI。',
            expectedStatus: 'done',
            requiredToolCalls: ['search_schema', 'query_database'],
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'success',
                caseSensitive: false,
                argumentIncludes: ['select', 'from analytics.traffic_sessions'],
              },
            ],
          },
          run: {
            allowedTools: ['search_schema', 'query_database'],
            mode: 'readonly',
            maxIterations: 5,
            maxToolExecutionMs: 10_000,
          },
        },
      ],
    });
  });

  it('parses JSON text and rejects invalid JSON with a targeted error', () => {
    const suite = parseAgentEvalSuiteManifestJson(
      JSON.stringify({
        version: 1,
        suite: {
          suiteId: 'json-suite',
          suiteName: 'JSON Suite',
          cases: [{ id: 'JSON-001', userTask: 'Run one case.' }],
        },
      }),
    );
    expect(suite.cases[0]?.case).toMatchObject({ id: 'JSON-001', userTask: 'Run one case.' });
    expect(() => parseAgentEvalSuiteManifestJson('{')).toThrow(
      /Agent eval suite manifest JSON is invalid:/,
    );
  });

  it('rejects duplicate case ids and invalid iteration or call ranges', () => {
    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: {
          suiteId: 'duplicate-suite',
          suiteName: 'Duplicate Suite',
          cases: [
            { id: 'CASE-001', userTask: 'First task.' },
            { id: 'CASE-001', userTask: 'Second task.' },
          ],
        },
      }),
    ).toThrow('Duplicate Agent eval suite case id: CASE-001.');

    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: {
          suiteId: 'bad-iterations',
          suiteName: 'Bad Iterations',
          cases: [{ id: 'CASE-001', userTask: 'Task.', minIterations: 3, maxIterations: 2 }],
        },
      }),
    ).toThrow('minIterations cannot be greater than maxIterations');

    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: {
          suiteId: 'bad-calls',
          suiteName: 'Bad Calls',
          cases: [
            {
              id: 'CASE-001',
              userTask: 'Task.',
              toolExpectations: [{ toolName: 'query_database', minCalls: 2, maxCalls: 1 }],
            },
          ],
        },
      }),
    ).toThrow('minCalls cannot be greater than maxCalls');
  });

  it('rejects manifest attempts to override provider, model, userMessage, or unsupported enums', () => {
    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: {
          suiteId: 'unsafe-run',
          suiteName: 'Unsafe Run',
          cases: [{ id: 'CASE-001', userTask: 'Task.', run: { model: 'other-model' } }],
        },
      }),
    ).toThrow('run cannot override model');

    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: {
          suiteId: 'bad-status',
          suiteName: 'Bad Status',
          cases: [{ id: 'CASE-001', userTask: 'Task.', expectedStatus: 'finished' }],
        },
      }),
    ).toThrow('expectedStatus is not supported: finished.');
  });

  it('rejects empty suites and unsupported manifest versions', () => {
    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 2,
        suite: { suiteId: 'future', suiteName: 'Future', cases: [] },
      }),
    ).toThrow('Agent eval suite manifest version is not supported: 2.');

    expect(() =>
      parseAgentEvalSuiteManifest({
        version: 1,
        suite: { suiteId: 'empty', suiteName: 'Empty', cases: [] },
      }),
    ).toThrow('Agent eval suite manifest suite must contain at least one case.');
  });
});
