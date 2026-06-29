import { describe, expect, it } from 'vitest';
import {
  buildAgentBehaviorEvaluationReport,
  evaluateAgentBehavior,
  type AgentRunResult,
} from '../src/index.js';

describe('evaluateAgentBehavior', () => {
  it('passes scenarios that match user-visible Agent behavior', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-001',
            userTask: '查询订单总数',
            expectedStatus: 'done',
            requiredToolCalls: ['query_database'],
            forbiddenToolCalls: ['execute_sql'],
            requiredToolStatuses: [{ toolName: 'query_database', status: 'success' }],
            finalTextIncludes: ['42'],
            minIterations: 2,
            maxIterations: 3,
          },
          result: runResult({
            finalText: '订单总数是 42。',
            iterations: 2,
            toolExecutions: [
              {
                toolCallId: 'call_1',
                toolName: 'query_database',
                status: 'success',
                durationMs: 1,
                resultPreview: '{}',
              },
            ],
          }),
        },
      ],
    });

    expect(summary).toMatchObject({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      passRate: 1,
    });
    expect(summary.results[0]?.failures).toEqual([]);
  });

  it('reports missing tools, forbidden tools, wrong status and weak final answer', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-002',
            userTask: '只读模式不能删除订单',
            expectedStatus: 'permission_denied',
            requiredToolCalls: ['query_database'],
            forbiddenToolCalls: ['execute_sql'],
            requiredToolStatuses: [{ toolName: 'execute_sql', status: 'denied' }],
            finalTextIncludes: ['拒绝'],
            maxIterations: 1,
          },
          result: runResult({
            status: 'done',
            finalText: '已经处理完成。',
            iterations: 2,
            toolExecutions: [
              {
                toolCallId: 'call_1',
                toolName: 'execute_sql',
                status: 'success',
                durationMs: 1,
                resultPreview: '{}',
              },
            ],
          }),
        },
      ],
    });

    expect(summary.failedCases).toBe(1);
    expect(summary.passRate).toBe(0);
    expect(summary.results[0]?.failures).toEqual([
      'Expected status permission_denied, got done.',
      'Required tool was not called: query_database.',
      'Forbidden tool was called: execute_sql.',
      'Expected tool execute_sql to have status denied.',
      'Final text does not include: 拒绝.',
      'Expected at most 1 iterations, got 2.',
    ]);
  });

  it('builds redacted JSON and Markdown report artifacts for user-level acceptance evidence', () => {
    const apiKey = ['sk', 'report-secret-123456'].join('-');
    const databaseUrl = 'postgres://tester:secret@127.0.0.1/db';
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-REPORT-001',
            userTask: '生成渠道 GMV 验收报告',
            expectedStatus: 'done',
            requiredToolCalls: ['search_schema', 'query_database'],
            finalTextIncludes: ['GMV'],
          },
          result: runResult({
            finalText: `GMV 已生成。测试密钥 ${apiKey} 和连接串 ${databaseUrl} 不应进入报告。`,
            toolExecutions: [
              {
                toolCallId: 'call_1',
                toolName: 'search_schema',
                status: 'success',
                durationMs: 1,
                resultPreview: '{}',
              },
              {
                toolCallId: 'call_2',
                toolName: 'query_database',
                status: 'success',
                durationMs: 2,
                resultPreview: '{}',
              },
            ],
          }),
        },
      ],
    });

    const report = buildAgentBehaviorEvaluationReport({
      suiteId: 'agent-rag-business',
      suiteName: 'Agent/RAG 业务验收',
      generatedAt: '2026-06-29T00:00:00.000Z',
      environment: 'llm-live',
      run: {
        providerId: 'siliconflow',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        live: true,
        postgres: true,
      },
      notes: ['真实报告不得包含明文密钥。'],
      summary,
    });

    expect(report.summary).toMatchObject({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      passRate: 1,
    });
    expect(report.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'results.json',
      'report.md',
    ]);
    const combined = report.files.map((file) => file.content).join('\n');
    expect(combined).toContain('Agent/RAG 业务验收');
    expect(combined).toContain('query_database');
    expect(combined).toContain('sk-[REDACTED]');
    expect(combined).toContain('postgres://tester:[REDACTED]@127.0.0.1/db');
    expect(combined).not.toContain(apiKey);
    expect(combined).not.toContain('tester:secret@');
    expect(report.files.every((file) => file.bytes > 0)).toBe(true);
  });
});

function runResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    status: 'done',
    session: {
      id: 'session_eval',
      title: 'eval',
      mode: 'readonly',
      strategy: 'react',
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
