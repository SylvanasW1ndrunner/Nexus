import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmRouter,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmProvider,
} from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import {
  AgentAuditLogStore,
  AgentCheckpointStore,
  AgentStreamStore,
  ReactAgent,
  ToolRegistry,
  type AgentToolApproval,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ReactAgent', () => {
  it('runs a readonly database tool and returns a final business answer', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'query_database',
            arguments: { sql: 'select count(*) as order_count from orders' },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: '订单总数是 42，可以继续按日期分析趋势。',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '帮我看一下订单总数',
      mode: 'readonly',
    });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('订单总数是 42，可以继续按日期分析趋势。');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_1', toolName: 'query_database', status: 'success' },
    ]);
    expect(result.session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.session.tokenUsage.totalTokens).toBe(43);
    await expect(usage.current()).resolves.toMatchObject({
      usedRounds: 1,
      byokTokenEstimate: 43,
    });
  });

  it('records redacted tool argument previews for user-level Agent evaluation', async () => {
    const apiKey = ['sk', 'agent-secret-123456'].join('-');
    const databaseUrl = ['postgres://tester', 'secret@127.0.0.1/db'].join(':');
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_secret',
            name: 'query_database',
            arguments: {
              sql: 'select count(*) as order_count from orders',
              apiKey,
              databaseUrl,
            },
          },
        ],
      },
      {
        text: '订单总数是 42。',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '帮我看一下订单总数',
      mode: 'readonly',
    });

    expect(result.status).toBe('done');
    expect(result.toolExecutions[0]).toMatchObject({
      toolCallId: 'call_secret',
      toolName: 'query_database',
      status: 'success',
    });
    const argumentPreview = result.toolExecutions[0]?.argumentPreview ?? '';
    expect(argumentPreview).toContain('select count(*) as order_count from orders');
    expect(argumentPreview).toContain('"redacted_secret"');
    expect(argumentPreview).toContain('"databaseUrl":"[REDACTED]"');
    const serialized = JSON.stringify(result.toolExecutions);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('tester:secret@');
  });

  it('redacts tool result PII before session persistence, model context, and final output', async () => {
    const auditLog = new AgentAuditLogStore(await auditPath());
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const usage = new UsageTracker(await usagePath());
    const rawEmail = 'alice@example.test';
    const rawPhone = '+8613800138000';
    const rawCipher = 'ciphertext-phone-value';
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_pii_query',
            name: 'query_database',
            arguments: { sql: 'select city, email, phone, phone_enc, customer_count from customers' },
          },
        ],
      },
      {
        text: `上海客户数 12。泄漏样例 ${rawEmail} ${rawPhone} phone_enc=${rawCipher}`,
        toolCalls: [],
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({
        rows: [
          {
            city: 'Shanghai',
            email: rawEmail,
            phone: rawPhone,
            phone_enc: rawCipher,
            customer_count: 12,
            email_domain: 'example.test',
            phone_prefix_masked: '138****',
          },
        ],
      }),
    );
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registry,
      usage,
      undefined,
      { ...fixedDependencies(), auditLog, checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '按城市统计客户数，输出脱敏后的汇总。',
      mode: 'readonly',
      maxIterations: 2,
    });
    const serializedSession = JSON.stringify(result.session);
    const secondCallContext = JSON.stringify(calls[1]?.messages ?? []);
    const auditEvents = await auditLog.readAll();
    const checkpoints = await checkpointStore.listBySession('session_test');
    const persistedEvidence = JSON.stringify({ auditEvents, checkpoints });

    expect(result.status).toBe('done');
    expect(result.finalText).toContain('上海客户数 12');
    expect(result.finalText).toContain('[REDACTED_PII]');
    expect(result.finalText).not.toContain(rawEmail);
    expect(result.finalText).not.toContain(rawPhone);
    expect(result.finalText).not.toContain(rawCipher);
    expect(result.finalText).not.toContain('phone_enc');
    expect(result.toolExecutions[0]).toMatchObject({
      toolCallId: 'call_pii_query',
      toolName: 'query_database',
      status: 'success',
      redacted: true,
    });
    expect(result.toolExecutions[0]?.redactionReasons).toEqual(
      expect.arrayContaining(['email', 'phone', 'sensitive_key']),
    );
    expect(result.toolExecutions[0]?.resultPreview).toContain('Shanghai');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"customer_count":12');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"email_domain":"example.test"');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"phone_prefix_masked":"138****"');
    for (const serialized of [serializedSession, secondCallContext, persistedEvidence, JSON.stringify(result.toolExecutions)]) {
      expect(serialized).not.toContain(rawEmail);
      expect(serialized).not.toContain(rawPhone);
      expect(serialized).not.toContain(rawCipher);
      expect(serialized).not.toContain('phone_enc');
    }
    expect(secondCallContext).toContain('[REDACTED_PII]');
    expect(persistedEvidence).toContain('"redacted":true');
  });

  it('writes a redacted Agent audit trail for model and tool execution replay', async () => {
    const auditLog = new AgentAuditLogStore(await auditPath());
    const apiKey = ['sk', 'audit-run-secret-123456'].join('-');
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'audit_query',
            name: 'query_database',
            arguments: {
              sql: 'select count(*) as order_count from orders',
              apiKey,
            },
          },
        ],
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      },
      {
        text: '订单总数是 42。',
        toolCalls: [],
        usage: { promptTokens: 16, completionTokens: 6, totalTokens: 22 },
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), auditLog },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '统计订单总数',
      mode: 'readonly',
      allowedTools: ['query_database'],
      maxIterations: 3,
    });
    const events = await auditLog.readAll();
    const serialized = JSON.stringify(events);

    expect(result.status).toBe('done');
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'model_call_started',
      'model_call_finished',
      'tool_call_started',
      'tool_call_finished',
      'model_call_started',
      'model_call_finished',
      'run_finished',
    ]);
    expect(events).toMatchObject([
      { type: 'run_started', sessionId: 'session_test', mode: 'readonly', allowedTools: ['query_database'] },
      { type: 'model_call_started', iteration: 1, providerId: 'fake', model: 'fake-model', toolCount: 1 },
      { type: 'model_call_finished', iteration: 1, toolCallCount: 1, usage: { totalTokens: 12 } },
      {
        type: 'tool_call_started',
        toolCallId: 'audit_query',
        toolName: 'query_database',
      },
      { type: 'tool_call_finished', toolCallId: 'audit_query', status: 'success' },
      { type: 'model_call_started', iteration: 2 },
      { type: 'model_call_finished', iteration: 2, toolCallCount: 0 },
      { type: 'run_finished', status: 'done', iterations: 2, finalTextPreview: '订单总数是 42。' },
    ]);
    const toolStarted = events.find((event) => event.type === 'tool_call_started');
    expect(toolStarted).toMatchObject({ type: 'tool_call_started', toolName: 'query_database' });
    expect(toolStarted?.argumentPreview).toContain('"redacted_secret"');
    expect(serialized).not.toContain(apiKey);
  });

  it('blocks non-readonly tools in readonly mode before side effects happen', async () => {
    let writeExecuted = false;
    const auditLog = new AgentAuditLogStore(await auditPath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with possible writes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        readonly: false,
      },
      () => {
        writeExecuted = true;
        return { ok: true };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'call_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } }],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      { ...fixedDependencies(), auditLog },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单表',
      mode: 'readonly',
    });

    expect(result.status).toBe('permission_denied');
    expect(writeExecuted).toBe(false);
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_write', toolName: 'execute_sql', status: 'denied' },
    ]);
    await expect(auditLog.readAll()).resolves.toMatchObject([
      { type: 'run_started' },
      { type: 'model_call_started' },
      { type: 'model_call_finished' },
      { type: 'tool_call_started', toolName: 'execute_sql' },
      { type: 'tool_call_finished', toolName: 'execute_sql', status: 'denied' },
      { type: 'run_finished', status: 'permission_denied' },
    ]);
  });

  it('blocks direct PII exfiltration requests before model or tool execution', async () => {
    const auditLog = new AgentAuditLogStore(await auditPath());
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'should not be called',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), auditLog },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Export every customer phone number in plaintext.',
      mode: 'readonly',
    });

    expect(result.status).toBe('safety_blocked');
    expect(result.iterations).toBe(0);
    expect(result.toolExecutions).toEqual([]);
    expect(result.finalText).toContain('敏感个人信息');
    expect(calls).toEqual([]);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0, byokTokenEstimate: 0 });
    await expect(auditLog.readAll()).resolves.toMatchObject([
      { type: 'run_started' },
      { type: 'run_finished', status: 'safety_blocked', iterations: 0 },
    ]);
  });

  it('does not execute ask-mode medium tools without an approval provider', async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write_workspace_file',
        description: 'Write a workspace artifact',
        inputSchema: { type: 'object' },
        dangerLevel: 'medium',
      },
      () => {
        executed = true;
        return 'written';
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'call_file', name: 'write_workspace_file', arguments: { path: 'report.md' } }],
          },
          {
            text: '需要用户批准后才能写入文件。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '写一个分析报告',
      mode: 'ask',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(executed).toBe(false);
    expect(result.toolExecutions).toMatchObject([{ status: 'denied', resultPreview: 'Permission: ask' }]);
    expect(result.finalText).toBe('需要用户批准后才能写入文件。');
  });

  it('passes approval provenance to tools only after the approval provider allows execution', async () => {
    let approvalSeen: AgentToolApproval | undefined;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with possible writes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        readonly: false,
      },
      (_args, context) => {
        approvalSeen = context.approval;
        return { ok: true };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'call_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } }],
          },
          {
            text: '已执行。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      () => true,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单',
      mode: 'ask',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(approvalSeen).toMatchObject({
      granted: true,
      source: 'approval-provider',
      toolCallId: 'call_write',
      toolName: 'execute_sql',
    });
  });

  it('returns tool failures to the model so the next iteration can recover', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      (args) => {
        if (String(args.sql).includes('missing_column')) {
          throw new Error('column missing_column does not exist');
        }
        return { rows: [{ order_count: 42 }] };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'bad_sql', name: 'query_database', arguments: { sql: 'select missing_column from orders' } }],
          },
          {
            text: '',
            toolCalls: [{ id: 'fixed_sql', name: 'query_database', arguments: { sql: 'select count(*) as order_count from orders' } }],
          },
          {
            text: '已修正 SQL，订单总数是 42。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '订单总数是多少',
      mode: 'readonly',
      maxIterations: 3,
    });

    expect(result.status).toBe('done');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'bad_sql', status: 'failed', failureKind: 'sql_repairable', retryable: true },
      { toolCallId: 'fixed_sql', status: 'success' },
    ]);
    expect(result.finalText).toBe('已修正 SQL，订单总数是 42。');
  });

  it('times out a hanging tool, aborts its signal, and lets the model recover', async () => {
    let toolSignalAborted = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      (_args, context) => {
        context.signal?.addEventListener('abort', () => {
          toolSignalAborted = true;
        });
        return new Promise<never>(() => undefined);
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              { id: 'slow_query', name: 'query_database', arguments: { sql: 'select pg_sleep(60)' } },
            ],
          },
          {
            text: '原查询超时，已建议缩小时间范围后重试。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '查询最近一年的明细',
      mode: 'readonly',
      maxIterations: 2,
      maxToolExecutionMs: 5,
    });

    expect(result.status).toBe('done');
    expect(toolSignalAborted).toBe(true);
    expect(result.toolExecutions).toMatchObject([
      {
        toolCallId: 'slow_query',
        toolName: 'query_database',
        status: 'failed',
        failureKind: 'timeout',
        retryable: true,
        resultPreview: '工具 query_database 执行超时（5ms）。',
      },
    ]);
    expect(result.finalText).toBe('原查询超时，已建议缩小时间范围后重试。');
    expect(result.session.messages.at(2)).toMatchObject({
      role: 'tool',
      content: JSON.stringify({ error: '工具 query_database 执行超时（5ms）。' }),
    });
  });

  it('counts tool timeouts toward the consecutive failure circuit breaker', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => new Promise<never>(() => undefined),
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              { id: 'slow_query', name: 'query_database', arguments: { sql: 'select pg_sleep(60)' } },
            ],
          },
          {
            text: 'should not be called',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '跑一个长查询',
      mode: 'readonly',
      maxIterations: 10,
      maxConsecutiveToolFailures: 1,
      maxToolExecutionMs: 5,
    });

    expect(result.status).toBe('tool_failed');
    expect(result.iterations).toBe(1);
    expect(result.finalText).toContain('连续 1 次工具执行失败');
    expect(result.finalText).toContain('工具 query_database 执行超时（5ms）。');
    await expect(checkpointStore.listBySession('session_test')).resolves.toMatchObject([
      {
        iteration: 1,
        status: 'failed',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        errorMessage: expect.stringContaining('工具 query_database 执行超时'),
      },
    ]);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0 });
  });

  it('stops after repeated tool failures instead of wasting the full iteration budget', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => {
        throw new Error('database connection reset');
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'fail_1', name: 'query_database', arguments: { sql: 'select count(*) from orders' } }],
          },
          {
            text: '',
            toolCalls: [{ id: 'fail_2', name: 'query_database', arguments: { sql: 'select count(*) from orders' } }],
          },
          {
            text: '',
            toolCalls: [{ id: 'fail_3', name: 'query_database', arguments: { sql: 'select count(*) from orders' } }],
          },
          {
            text: 'should not be called',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '连续查询直到成功',
      mode: 'readonly',
      maxIterations: 10,
    });

    expect(result.status).toBe('tool_failed');
    expect(result.iterations).toBe(3);
    expect(result.finalText).toContain('连续 3 次工具执行失败');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'fail_1', status: 'failed' },
      { toolCallId: 'fail_2', status: 'failed' },
      { toolCallId: 'fail_3', status: 'failed' },
    ]);
    await expect(checkpointStore.listBySession('session_test')).resolves.toMatchObject([
      { iteration: 1, status: 'running' },
      { iteration: 2, status: 'running' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      { iteration: 3, status: 'failed', errorMessage: expect.stringContaining('连续 3 次工具执行失败') },
    ]);
    await expect(checkpointStore.listRecoverable()).resolves.toEqual([]);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0 });
    await expect(usage.roundHistory()).resolves.toMatchObject([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      { sessionId: 'session_test', status: 'failed', errorMessage: expect.stringContaining('连续 3 次工具执行失败') },
    ]);
  });

  it('persists recoverable checkpoints across model and tool steps', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      (args) => {
        if (String(args.sql).includes('bad_column')) throw new Error('column bad_column does not exist');
        return { rows: [{ order_count: 42 }] };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'bad_sql', name: 'query_database', arguments: { sql: 'select bad_column from orders' } }],
          },
          {
            text: '',
            toolCalls: [{ id: 'fixed_sql', name: 'query_database', arguments: { sql: 'select count(*) from orders' } }],
          },
          {
            text: 'order count is 42',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Analyze order count',
      mode: 'readonly',
      maxIterations: 3,
    });

    const checkpoints = await checkpointStore.listBySession(result.session.id);

    expect(result.status).toBe('done');
    expect(checkpoints).toMatchObject([
      {
        iteration: 1,
        status: 'running',
        toolExecutions: [{ toolCallId: 'bad_sql', status: 'failed' }],
      },
      {
        iteration: 2,
        status: 'running',
        toolExecutions: [
          { toolCallId: 'bad_sql', status: 'failed' },
          { toolCallId: 'fixed_sql', status: 'success' },
        ],
      },
      {
        iteration: 3,
        status: 'done',
        finalText: 'order count is 42',
      },
    ]);
    await expect(checkpointStore.listRecoverable()).resolves.toEqual([]);
  });

  it('persists model stream events during an Agent run', async () => {
    const usage = new UsageTracker(await usagePath(), { createRoundId: () => 'round_test' });
    const streamStore = new AgentStreamStore(await streamPath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        streamingProvider([
          { type: 'text-delta', text: '订单' },
          { type: 'text-delta', text: '总数是 42。' },
          {
            type: 'finish',
            response: {
              text: '订单总数是 42。',
              toolCalls: [],
              usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
            },
          },
        ]),
      ]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), streamStore },
    );

    const result = await agent.run({
      providerId: 'streaming',
      model: 'fake-stream-model',
      userMessage: '帮我看一下订单总数',
      mode: 'readonly',
    });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('订单总数是 42。');
    await expect(streamStore.listRecoverable()).resolves.toEqual([]);
    await expect(streamStore.listBySession('session_test')).resolves.toMatchObject([{
      status: 'complete',
      sessionId: 'session_test',
      roundId: 'round_test',
      providerId: 'streaming',
      model: 'fake-stream-model',
      text: '订单总数是 42。',
      chunks: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
    }]);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 1, byokTokenEstimate: 16 });
  });

  it('keeps partial model stream output recoverable when an Agent run fails mid-stream', async () => {
    const usage = new UsageTracker(await usagePath());
    const streamStore = new AgentStreamStore(await streamPath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [interruptingStreamingProvider()]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), streamStore },
    );

    await expect(
      agent.run({
        providerId: 'streaming',
        model: 'fake-stream-model',
        userMessage: '分析订单后继续分析退款',
        mode: 'readonly',
      }),
    ).rejects.toThrow('stream network reset');

    await expect(streamStore.listRecoverable()).resolves.toMatchObject([
      {
        status: 'incomplete',
        sessionId: 'session_test',
        text: '已查到订单，',
        errorMessage: 'stream network reset',
      },
    ]);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0 });
    await expect(usage.roundHistory()).resolves.toMatchObject([{ status: 'failed' }]);
  });

  it('only exposes tools allowed by the current skill execution plan', async () => {
    const registry = registryWithReadAndWriteTools();
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'Only query tools are available.',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run a readonly skill query.',
      mode: 'readonly',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
  });

  it('compresses long conversation context before model calls', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [{ id: 'large_result', name: 'query_database', arguments: { sql: 'select * from orders' } }],
      },
      {
        text: '已基于摘要继续分析。',
        toolCalls: [],
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ rows: Array.from({ length: 200 }, (_, index) => ({ id: index, amount: index * 10 })) }),
    );
    const agent = new ReactAgent(new LlmRouter(usage, [provider]), registry, usage, undefined, fixedDependencies());

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '分析所有订单明细',
      mode: 'readonly',
      maxIterations: 2,
      contextWindowTokens: 120,
      maxToolResultChars: 240,
    });

    expect(result.status).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.some((message) => message.content.includes('工具结果已在本地摘要'))).toBe(true);
  });

  it('bounds large tool results before persisting them into the session and model context', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [{ id: 'large_export', name: 'query_database', arguments: { sql: 'select * from event_logs' } }],
      },
      {
        text: 'The large result was summarized before analysis.',
        toolCalls: [],
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({
        rows: Array.from({ length: 500 }, (_, index) => ({
          id: index,
          payload: `large-payload-${index}-${'x'.repeat(80)}`,
        })),
      }),
    );
    const agent = new ReactAgent(new LlmRouter(usage, [provider]), registry, usage, undefined, fixedDependencies());

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Analyze a large event log export.',
      mode: 'readonly',
      maxIterations: 2,
      maxToolResultChars: 260,
    });

    const toolMessage = result.session.messages.find((message) => message.role === 'tool');

    expect(result.status).toBe('done');
    expect(result.toolExecutions[0]?.resultPreview.length).toBeLessThanOrEqual(260);
    expect(result.toolExecutions[0]?.resultPreview).toContain('tool_result_too_large');
    expect(toolMessage?.content.length).toBeLessThanOrEqual(260);
    expect(toolMessage?.content).toContain('tool_result_too_large');
    expect(calls[1]?.messages.some((message) => message.content.includes('tool_result_too_large'))).toBe(true);
    expect(calls[1]?.messages.some((message) => message.content.includes('large-payload-499'))).toBe(false);
  });

  it('denies tool calls that are registered but not allowed for the current run', async () => {
    let writeExecuted = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ rows: [] }),
    );
    registry.register(
      {
        name: 'execute_sql',
        description: 'Execute SQL with possible writes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        readonly: false,
      },
      () => {
        writeExecuted = true;
        return { ok: true };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'hidden_write', name: 'execute_sql', arguments: { sql: 'drop table orders' } }],
          },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run a skill that allows readonly query only.',
      mode: 'full-auto',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('permission_denied');
    expect(writeExecuted).toBe(false);
    expect(result.finalText).toBe('Tool is not allowed for this run.');
    expect(result.toolExecutions).toMatchObject([
      {
        toolCallId: 'hidden_write',
        toolName: 'execute_sql',
        status: 'denied',
        resultPreview: 'Tool not allowed by run policy.',
      },
    ]);
  });

  it('stops subscription Agent runs before calling the model when quota is exhausted', async () => {
    const usage = new UsageTracker(await usagePath(), { subscriptionRoundLimit: 0 });
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'should not run',
        toolCalls: [],
      },
    ]);
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run subscription task.',
      mode: 'readonly',
      usageMode: 'subscription',
    });

    expect(result.status).toBe('quota_exceeded');
    expect(calls).toHaveLength(0);
    await expect(usage.roundHistory()).resolves.toEqual([]);
  });

  it('counts user-aborted Agent rounds without calling the model', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: 'should not run',
        toolCalls: [],
      },
    ]);
    const signal = AbortSignal.abort();
    const agent = new ReactAgent(
      new LlmRouter(usage, [provider]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Start then stop.',
      mode: 'readonly',
      signal,
    });

    expect(result.status).toBe('aborted');
    expect(calls).toHaveLength(0);
    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 1 });
    await expect(usage.roundHistory()).resolves.toMatchObject([{ status: 'aborted' }]);
  });

  it('does not count provider infrastructure failures as billable Agent rounds', async () => {
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [throwingProvider('provider timeout')]),
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    await expect(
      agent.run({
        providerId: 'throwing',
        model: 'fake-model',
        userMessage: 'Analyze orders.',
        mode: 'readonly',
      }),
    ).rejects.toThrow('provider timeout');

    await expect(usage.current()).resolves.toMatchObject({ usedRounds: 0 });
    await expect(usage.roundHistory()).resolves.toMatchObject([
      { sessionId: 'session_test', status: 'failed', errorMessage: 'provider timeout' },
    ]);
  });
});

function registryWithQueryTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'query_database',
      description: 'Execute readonly SQL',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      dangerLevel: 'safe',
      readonly: true,
    },
    () => ({ rows: [{ order_count: 42 }] }),
  );
  return registry;
}

function registryWithReadAndWriteTools(): ToolRegistry {
  const registry = registryWithQueryTool();
  registry.register(
    {
      name: 'execute_sql',
      description: 'Execute SQL with possible writes',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      dangerLevel: 'high',
      readonly: false,
    },
    () => ({ ok: true }),
  );
  return registry;
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return scriptedProviderWithCalls(script).provider;
}

function scriptedProviderWithCalls(script: LlmChatResponse[]): { provider: LlmProvider; calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat(request) {
      calls.push(request);
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return Promise.resolve(next);
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
  return { provider, calls };
}

function throwingProvider(message: string): LlmProvider {
  return {
    id: 'throwing',
    name: 'Throwing Provider',
    mode: 'byok',
    chat() {
      return Promise.reject(new Error(message));
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

function streamingProvider(events: LlmChatStreamEvent[]): LlmProvider {
  return {
    id: 'streaming',
    name: 'Streaming Provider',
    mode: 'byok',
    chat() {
      return Promise.reject(new Error('chat should not be called when stream store is configured'));
    },
    async *stream() {
      await Promise.resolve();
      for (const event of events) yield event;
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

function interruptingStreamingProvider(): LlmProvider {
  return {
    id: 'streaming',
    name: 'Interrupting Streaming Provider',
    mode: 'byok',
    chat() {
      return Promise.reject(new Error('chat should not be called when stream store is configured'));
    },
    async *stream() {
      yield { type: 'text-delta', text: '已查到订单，' };
      await Promise.resolve();
      throw new Error('stream network reset');
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

async function checkpointPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-checkpoint-run-'));
  tempDirs.push(dir);
  return join(dir, 'agent-checkpoints.json');
}

async function streamPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-stream-run-'));
  tempDirs.push(dir);
  return join(dir, 'agent-streams.json');
}

async function auditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-audit-run-'));
  tempDirs.push(dir);
  return join(dir, 'agent-2026-07-07.jsonl');
}

function fixedDependencies() {
  return {
    now: () => '2026-06-17T00:00:00.000Z',
    createSessionId: () => 'session_test',
  };
}
