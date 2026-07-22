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

  it('checks tool arguments, tool results, call counts and forbidden final text', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-003',
            userTask: '按渠道分析 GMV、退款率和 ROI',
            expectedStatus: 'done',
            toolExpectations: [
              {
                toolName: 'search_schema',
                status: 'success',
                minCalls: 1,
                maxCalls: 1,
                argumentIncludes: ['GMV', 'ROI'],
                argumentExcludes: ['drop table'],
                resultIncludes: ['public.orders', 'analytics.campaign_spend'],
              },
              {
                toolName: 'query_database',
                status: 'success',
                minCalls: 1,
                argumentIncludes: ['select', 'analytics.traffic_sessions'],
                resultIncludes: ['paid_search'],
                resultExcludes: ['password'],
              },
            ],
            finalTextIncludes: ['paid_search'],
            finalTextExcludes: ['sk-secret'],
          },
          result: runResult({
            finalText: 'paid_search 渠道 GMV 为 199.00。',
            toolExecutions: [
              {
                toolCallId: 'call_schema',
                toolName: 'search_schema',
                status: 'success',
                durationMs: 1,
                argumentPreview: '{"query":"GMV ROI"}',
                resultPreview: 'public.orders analytics.campaign_spend',
              },
              {
                toolCallId: 'call_query',
                toolName: 'query_database',
                status: 'success',
                durationMs: 2,
                argumentPreview: '{"sql":"select * from analytics.traffic_sessions"}',
                resultPreview: '{"rows":[{"utm_source":"paid_search"}]}',
              },
            ],
          }),
        },
      ],
    });

    expect(summary.passRate).toBe(1);
    expect(summary.results[0]?.observedToolDetails).toMatchObject([
      {
        toolCallId: 'call_schema',
        toolName: 'search_schema',
        status: 'success',
        argumentPreview: '{"query":"GMV ROI"}',
      },
      {
        toolCallId: 'call_query',
        toolName: 'query_database',
        status: 'success',
      },
    ]);
  });

  it('supports case-insensitive matching for tool expectation snippets', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-CASE-INSENSITIVE-001',
            userTask: 'Validate SQL generated by a live model',
            expectedStatus: 'done',
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'success',
                caseSensitive: false,
                argumentIncludes: ['select', 'from public.orders'],
                argumentExcludes: ['drop table'],
                resultIncludes: ['paid_search'],
                resultExcludes: ['raw_secret'],
              },
            ],
          },
          result: runResult({
            toolExecutions: [
              {
                toolCallId: 'call_query',
                toolName: 'query_database',
                status: 'success',
                durationMs: 2,
                argumentPreview: '{"sql":"SELECT * FROM PUBLIC.ORDERS"}',
                resultPreview: '{"rows":[{"UTM_SOURCE":"PAID_SEARCH"}]}',
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
  });

  it('checks whether a tool result was blocked by output safety', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-BLOCKED-001',
            userTask: 'Verify unsafe tool output is blocked and recoverable',
            expectedStatus: 'done',
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'failed',
                blocked: true,
                resultIncludes: ['tool_result_blocked_by_output_safety'],
              },
            ],
          },
          result: runResult({
            toolExecutions: [
              {
                toolCallId: 'unsafe_query',
                toolName: 'query_database',
                status: 'failed',
                durationMs: 1,
                resultPreview: '{"error":"tool_result_blocked_by_output_safety"}',
                failureKind: 'output_safety',
                retryable: true,
                blocked: true,
              },
            ],
          }),
        },
      ],
    });

    expect(summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
    expect(summary.results[0]?.observedToolDetails).toMatchObject([
      { toolName: 'query_database', status: 'failed', blocked: true },
    ]);
  });

  it('reports detailed tool expectation failures', () => {
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-004',
            userTask: '验证错误工具参数会被验收拦截',
            expectedStatus: 'done',
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'success',
                minCalls: 2,
                maxCalls: 1,
                argumentIncludes: ['orders'],
                argumentExcludes: ['delete'],
                resultIncludes: ['paid_search'],
                resultExcludes: ['raw_secret'],
              },
            ],
            finalTextExcludes: ['raw_secret'],
          },
          result: runResult({
            finalText: 'raw_secret should not be visible',
            toolExecutions: [
              {
                toolCallId: 'call_bad',
                toolName: 'query_database',
                status: 'failed',
                durationMs: 1,
                argumentPreview: '{"sql":"delete from users"}',
                resultPreview: '{"error":"raw_secret leaked"}',
              },
            ],
          }),
        },
      ],
    });

    expect(summary.failedCases).toBe(1);
    expect(summary.results[0]?.failures).toEqual([
      'Expected tool query_database to be called at least 2 times, got 1.',
      'Expected tool query_database to have status success.',
      'Tool query_database arguments does not include: orders.',
      'Tool query_database arguments includes forbidden snippet: delete.',
      'Tool query_database result does not include: paid_search.',
      'Tool query_database result includes forbidden snippet: raw_secret.',
      'Final text includes forbidden snippet: raw_secret.',
    ]);
  });

  it('builds redacted JSON and Markdown report artifacts for user-level acceptance evidence', () => {
    const apiKey = ['sk', 'report-secret-123456'].join('-');
    const databaseUrl = ['postgres://tester', 'secret@127.0.0.1/db'].join(':');
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
                argumentPreview: `{"query":"GMV","apiKey":"${apiKey}"}`,
                resultPreview: '{}',
              },
              {
                toolCallId: 'call_2',
                toolName: 'query_database',
                status: 'success',
                durationMs: 2,
                argumentPreview: `{"connectionString":"${databaseUrl}"}`,
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
      suiteSource: { kind: 'builtin', skillName: 'nl2sql_query' },
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
    expect(combined).toContain('nl2sql_query');
    expect(combined).toContain('query_database');
    expect(combined).toContain('Tool Details');
    expect(combined).toContain('sk-[REDACTED]');
    expect(combined).toContain('tester:[REDACTED]@127.0.0.1/db');
    expect(combined).not.toContain(apiKey);
    expect(combined).not.toContain('tester:secret@');
    expect(report.files.every((file) => file.bytes > 0)).toBe(true);
    expect(report.suiteSource).toEqual({ kind: 'builtin', skillName: 'nl2sql_query' });
  });

  it('redacts user data from evaluation report artifacts even when raw Agent results are passed in', () => {
    const rawEmail = 'alice@example.test';
    const rawPhone = '+8613800138000';
    const rawCipher = 'ciphertext-phone-value';
    const summary = evaluateAgentBehavior({
      cases: [
        {
          case: {
            id: 'AGENT-REPORT-PII-001',
            userTask: '按城市统计客户数',
            expectedStatus: 'done',
            requiredToolCalls: ['query_database'],
            finalTextIncludes: ['Shanghai'],
            finalTextExcludes: [rawEmail, rawPhone, rawCipher, 'phone_enc'],
            toolExpectations: [
              {
                toolName: 'query_database',
                status: 'success',
                resultExcludes: [rawEmail, rawPhone, rawCipher, 'phone_enc'],
              },
            ],
          },
          result: runResult({
            finalText: `Shanghai customer_count=12, leaked ${rawEmail} ${rawPhone} phone_enc=${rawCipher}`,
            toolExecutions: [
              {
                toolCallId: 'call_pii',
                toolName: 'query_database',
                status: 'success',
                durationMs: 1,
                resultPreview: JSON.stringify({
                  rows: [
                    {
                      city: 'Shanghai',
                      email: rawEmail,
                      phone: rawPhone,
                      phone_enc: rawCipher,
                      customer_count: 12,
                      email_domain: 'example.test',
                    },
                  ],
                }),
              },
            ],
          }),
        },
      ],
    });
    const report = buildAgentBehaviorEvaluationReport({
      suiteId: 'agent-pii-report',
      suiteName: 'Agent PII report safety',
      generatedAt: '2026-07-08T00:00:00.000Z',
      environment: 'integration',
      summary,
    });
    const combined = report.files.map((file) => file.content).join('\n');

    expect(combined).toContain('[REDACTED_PII]');
    expect(combined).toContain('redacted_encrypted');
    expect(combined).toContain('example.test');
    expect(combined).not.toContain(rawEmail);
    expect(combined).not.toContain(rawPhone);
    expect(combined).not.toContain(rawCipher);
    expect(combined).not.toContain('phone_enc');
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
