import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunOptions, AgentRunResult } from '@dbagent/core-agent';
import { runAgentBehaviorEvaluationSuite, type AgentEvalSuiteAgent } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runAgentBehaviorEvaluationSuite', () => {
  it('runs business Agent cases, evaluates tool evidence, and persists a redacted report', async () => {
    const apiKey = ['sk', 'eval-runner-secret-123456'].join('-');
    const agent = recordingAgent([
      runResult({
        finalText: `paid_search GMV 已生成，密钥 ${apiKey} 不应进入报告。`,
        toolExecutions: [
          {
            toolCallId: 'schema_1',
            toolName: 'search_schema',
            status: 'success',
            durationMs: 1,
            argumentPreview: `{"query":"GMV","apiKey":"${apiKey}"}`,
            resultPreview: 'public.orders analytics.campaign_spend',
          },
          {
            toolCallId: 'query_1',
            toolName: 'query_database',
            status: 'success',
            durationMs: 2,
            argumentPreview: '{"sql":"select * from analytics.traffic_sessions"}',
            resultPreview: '{"rows":[{"utm_source":"paid_search"}]}',
          },
        ],
      }),
    ]);
    const reportStorePath = join(await tempDir(), 'reports.json');

    const output = await runAgentBehaviorEvaluationSuite({
      agent,
      reportStorePath,
      generatedAt: '2026-07-02T00:00:00.000Z',
      suiteSource: { kind: 'imported', path: 'evals/ecommerce.json' },
      baseRun: {
        providerId: 'fake',
        model: 'fake-model',
        mode: 'read',
        maxIterations: 5,
      },
      suite: {
        suiteId: 'agent-rag-ecommerce',
        suiteName: 'Agent/RAG 电商业务验收',
        environment: 'integration',
        notes: ['报告必须脱敏。'],
        cases: [
          {
            case: {
              id: 'EVAL-001',
              userTask: '按渠道统计 GMV 和 ROI',
              expectedStatus: 'done',
              toolExpectations: [
                {
                  toolName: 'search_schema',
                  status: 'success',
                  argumentIncludes: ['GMV'],
                  resultIncludes: ['public.orders'],
                },
                {
                  toolName: 'query_database',
                  status: 'success',
                  argumentIncludes: ['analytics.traffic_sessions'],
                  resultIncludes: ['paid_search'],
                },
              ],
              finalTextIncludes: ['paid_search'],
            },
            run: { maxToolExecutionMs: 10_000 },
          },
        ],
      },
    });

    expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
    expect(output.savedReport).toMatchObject({
      suiteId: 'agent-rag-ecommerce',
      suiteName: 'Agent/RAG 电商业务验收',
      passRate: 1,
    });
    expect(agent.calls).toMatchObject([
      {
        providerId: 'fake',
        model: 'fake-model',
        mode: 'read',
        maxIterations: 5,
        maxToolExecutionMs: 10_000,
        userMessage: '按渠道统计 GMV 和 ROI',
      },
    ]);
    const combined = output.report.files.map((file) => file.content).join('\n');
    expect(combined).toContain('Tool Details');
    expect(combined).toContain('evals/ecommerce.json');
    expect(combined).toContain('sk-[REDACTED]');
    expect(combined).not.toContain(apiKey);
    expect(output.report.suiteSource).toEqual({
      kind: 'imported',
      path: 'evals/ecommerce.json',
    });
    expect(
      JSON.parse(output.report.files.find((file) => file.path === 'manifest.json')!.content),
    ).toMatchObject({
      suiteSource: { kind: 'imported', path: 'evals/ecommerce.json' },
    });
  });

  it('stops on the first failed case when requested', async () => {
    const agent = recordingAgent([
      runResult({
        finalText: '没有调用工具。',
        toolExecutions: [],
      }),
      runResult({
        finalText: '第二个用例不应运行。',
      }),
    ]);

    const output = await runAgentBehaviorEvaluationSuite({
      agent,
      stopOnFirstFailure: true,
      baseRun: {
        providerId: 'fake',
        model: 'fake-model',
        mode: 'read',
      },
      suite: {
        suiteId: 'agent-rag-stop',
        suiteName: 'Agent/RAG 失败停止验收',
        cases: [
          {
            case: {
              id: 'FAIL-001',
              userTask: '必须查询数据库',
              expectedStatus: 'done',
              requiredToolCalls: ['query_database'],
            },
          },
          {
            case: {
              id: 'FAIL-002',
              userTask: '第二个任务',
              expectedStatus: 'done',
            },
          },
        ],
      },
    });

    expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 0, failedCases: 1 });
    expect(output.caseResults.map((item) => item.caseId)).toEqual(['FAIL-001']);
    expect(agent.calls).toHaveLength(1);
  });

  it('rejects empty suites before calling the Agent', async () => {
    const agent = recordingAgent([]);

    await expect(
      runAgentBehaviorEvaluationSuite({
        agent,
        baseRun: {
          providerId: 'fake',
          model: 'fake-model',
        },
        suite: {
          suiteId: 'empty',
          suiteName: '空套件',
          cases: [],
        },
      }),
    ).rejects.toThrow('Agent eval suite must contain at least one case.');
    expect(agent.calls).toEqual([]);
  });
});

function recordingAgent(
  script: AgentRunResult[],
): AgentEvalSuiteAgent & { calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  return {
    calls,
    run(options) {
      calls.push(options);
      const next = script.shift();
      if (!next) throw new Error('No scripted Agent result left.');
      return Promise.resolve(next);
    },
  };
}

function runResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    status: 'done',
    session: {
      id: 'session_eval_suite',
      title: 'eval suite',
      mode: 'read',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
    finalText: '',
    iterations: 1,
    toolExecutions: [],
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-eval-suite-'));
  tempDirs.push(dir);
  return dir;
}
