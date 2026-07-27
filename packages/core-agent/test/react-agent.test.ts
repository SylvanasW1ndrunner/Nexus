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
import { parsePublicJson } from '@dbagent/shared';
import { UsageTracker } from '@dbagent/core-usage';
import {
  AgentAuditLogStore,
  AgentToolApprovalBroker,
  AgentCheckpointStore,
  AgentStreamStore,
  appendMessage,
  createAgentSession,
  createMessage,
  ReactAgent,
  ToolRegistry,
  createAgentToolResultEnvelope,
  type AgentToolApproval,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ReactAgent', () => {
  it('treats a process-only response as a completion proposal and explicitly finalizes', async () => {
    const usage = new UsageTracker(await usagePath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'sql_execute',
        description: 'Execute readonly SQL',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        source: 'database',
      },
      () =>
        createAgentToolResultEnvelope({
          modelProjection: { rows: [{ count: 42 }], returnedRowCount: 1 },
          durableSummary: { returnedRowCount: 1, elapsedMs: 3 },
          completionEvidence: {
            kind: 'database-result',
            deliveryReady: true,
          },
        }),
    );
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [
          {
            id: 'sql-finalize',
            name: 'sql_execute',
            arguments: { sql: 'select count(*) as count from orders' },
          },
        ],
      },
      { text: 'Let me verify the result before I answer.', toolCalls: [] },
      { text: 'The query completed; the bounded result is returned separately.', toolCalls: [] },
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
      userMessage: 'Count the orders.',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.finalText).toBe(
      'The query completed; the bounded result is returned separately.',
    );
    expect(result.completion).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
      phase: 'done',
      evidenceKinds: ['database-result'],
    });
    expect(
      calls[2]?.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('previous response described future work'),
      ),
    ).toBe(true);
  });

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
      mode: 'read',
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
      completedRounds: 1,
      totalTokens: 43,
    });
  });

  it('does not mistake unparsed provider tool markup for a completed answer', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: [
          '<tool_calls>',
          '<tool_call name="query_database">',
          '{"sql":"select count(*) from orders"}',
          '</tool_call>',
          '</tool_calls>',
        ].join('\n'),
        toolCalls: [],
      },
      {
        text: '',
        toolCalls: [
          {
            id: 'call_recovered',
            name: 'query_database',
            arguments: { sql: 'select count(*) from orders' },
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
      userMessage: '查询订单总数',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.finalText).toBe('订单总数是 42。');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_recovered', status: 'success' },
    ]);
    expect(result.events).toBeDefined();
    if (!result.events) {
      throw new Error('Expected a correcting event for malformed tool markup.');
    }
    const correction = result.events.find((event) => event.type === 'correcting');
    expect(correction?.message).toContain('标准工具调用');
  });

  it('recovers when a provider leaves a JSON tool-call array inside text markup', async () => {
    const usage = new UsageTracker(await usagePath());
    const provider = scriptedProvider([
      {
        text: [
          'I need one more database check.',
          '<tool_calls>[{"name":"query_database","arguments":{"sql":"select count(*) from orders"}}]</tool_calls>',
        ].join('\n'),
        toolCalls: [],
      },
      {
        text: '',
        toolCalls: [
          {
            id: 'call_json_markup_recovered',
            name: 'query_database',
            arguments: { sql: 'select count(*) from orders' },
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
      userMessage: '查询订单总数',
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.finalText).toBe('订单总数是 42。');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'call_json_markup_recovered', status: 'success' },
    ]);
    expect(
      result.events?.some(
        (event) => event.type === 'correcting' && event.message.includes('标准工具调用'),
      ),
    ).toBe(true);
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
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.toolExecutions[0]).toMatchObject({
      toolCallId: 'call_secret',
      toolName: 'query_database',
      status: 'success',
    });
    const argumentPreview = result.toolExecutions[0]?.argumentPreview ?? '';
    expect(argumentPreview).toContain('select count(*) as order_count from orders');
    expect(argumentPreview).toContain('"apiKey":"[REDACTED]"');
    expect(argumentPreview).toContain('"databaseUrl":"[REDACTED]"');
    const serialized = JSON.stringify(result.toolExecutions);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('tester:secret@');
  });

  it('serializes Portable tool result values without losing their types', async () => {
    const usage = new UsageTracker(await usagePath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'portable_result',
        description: 'Return values supported by the public transport contract',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        source: 'builtin',
      },
      () => ({
        exactCount: 9_007_199_254_740_993n,
        observedAt: new Date('2026-07-26T04:00:00.000Z'),
        fingerprint: Uint8Array.from([0, 127, 255]),
      }),
    );
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [{ id: 'portable_call', name: 'portable_result', arguments: {} }],
          },
          { text: 'Portable values received.', toolCalls: [] },
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
      userMessage: 'Read the portable values.',
      mode: 'read',
    });
    const preview = result.toolExecutions[0]?.resultPreview ?? '';
    const decoded = parsePublicJson(preview) as {
      exactCount: bigint;
      observedAt: Date;
      fingerprint: Uint8Array;
    };

    expect(preview).not.toContain('Tool result could not be serialized');
    expect(decoded.exactCount).toBe(9_007_199_254_740_993n);
    expect(decoded.observedAt).toEqual(new Date('2026-07-26T04:00:00.000Z'));
    expect(decoded.fingerprint).toEqual(Uint8Array.from([0, 127, 255]));
  });

  it('preserves database row values while redacting arguments, configuration, and errors', async () => {
    const argumentSecret = ['sk', 'argument-secret-123456'].join('-');
    const configurationSecret = ['sk', 'configuration-secret-123456'].join('-');
    const errorSecret = ['sk', 'error-secret-123456'].join('-');
    const usage = new UsageTracker(await usagePath());
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'database_business_rows',
        description: 'Return database business rows',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        source: 'database',
      },
      () => ({
        rows: [
          {
            password: 'customer-password-business-value',
            token: 'customer-token-business-value',
            secret: 'customer-secret-business-value',
          },
        ],
        config: {
          password: configurationSecret,
        },
      }),
    );
    registry.register(
      {
        name: 'database_failure',
        description: 'Return a redacted database failure',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        source: 'database',
      },
      () => {
        throw new Error(`database failed apiKey=${errorSecret}`);
      },
    );
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              {
                id: 'database_rows',
                name: 'database_business_rows',
                arguments: { apiKey: argumentSecret },
              },
              {
                id: 'database_error',
                name: 'database_failure',
                arguments: { apiKey: argumentSecret },
              },
            ],
          },
          { text: 'Database checks completed.', toolCalls: [] },
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
      userMessage: 'Read the requested business columns.',
      mode: 'read',
    });
    const success = result.toolExecutions.find(
      (execution) => execution.toolCallId === 'database_rows',
    );
    const failure = result.toolExecutions.find(
      (execution) => execution.toolCallId === 'database_error',
    );

    expect(success?.resultPreview).toContain('"password":"customer-password-business-value"');
    expect(success?.resultPreview).toContain('"token":"customer-token-business-value"');
    expect(success?.resultPreview).toContain('"secret":"customer-secret-business-value"');
    expect(success?.resultPreview).not.toContain(configurationSecret);
    expect(success?.resultPreview).toContain('"config":{"password":"[REDACTED]"}');
    expect(success?.argumentPreview).not.toContain(argumentSecret);
    expect(success?.argumentPreview).toContain('"apiKey":"[REDACTED]"');
    expect(failure?.resultPreview).not.toContain(errorSecret);
    expect(failure?.resultPreview).toContain('[REDACTED]');
  });

  it('preserves database content while redacting secrets from persistence and model context', async () => {
    const auditLog = new AgentAuditLogStore(await auditPath());
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const usage = new UsageTracker(await usagePath());
    const businessLabel = 'sample-customer';
    const regionCode = 'cn-east';
    const opaquePayload = 'ciphertext-domain-value';
    const apiKey = ['sk', 'tool-result-secret-123456'].join('-');
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_customer_query',
            name: 'query_database',
            arguments: {
              sql: 'select city, business_label, region_code, opaque_payload, customer_count from customers',
            },
          },
        ],
      },
      {
        text: `上海客户数 12。样例 ${businessLabel} ${regionCode} opaque_payload=${opaquePayload} apiKey=${apiKey}`,
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
            business_label: businessLabel,
            region_code: regionCode,
            opaque_payload: opaquePayload,
            apiKey,
            customer_count: 12,
            segment: 'enterprise',
            active: true,
            observed_at: new Date('2026-03-01T10:00:00.000Z'),
          },
        ],
      }),
    );
    const agent = new ReactAgent(new LlmRouter(usage, [provider]), registry, usage, undefined, {
      ...fixedDependencies(),
      auditLog,
      checkpointStore,
    });

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '按城市统计客户数，输出脱敏后的汇总。',
      mode: 'read',
      maxIterations: 2,
    });
    const serializedSession = JSON.stringify(result.session);
    const secondCallContext = JSON.stringify(calls[1]?.messages ?? []);
    const auditEvents = await auditLog.readAll();
    const checkpoints = await checkpointStore.listBySession('session_test');
    const persistedEvidence = JSON.stringify({ auditEvents, checkpoints });

    expect(result.status).toBe('done');
    expect(result.finalText).toContain('上海客户数 12');
    expect(result.finalText).toContain(businessLabel);
    expect(result.finalText).toContain(regionCode);
    expect(result.finalText).toContain(opaquePayload);
    expect(result.finalText).toContain('opaque_payload');
    expect(result.finalText).not.toContain(apiKey);
    expect(result.finalText).toContain('[REDACTED]');
    expect(result.toolExecutions[0]).toMatchObject({
      toolCallId: 'call_customer_query',
      toolName: 'query_database',
      status: 'success',
    });
    expect(result.toolExecutions[0]?.resultPreview).toContain('Shanghai');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"customer_count":12');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"segment":"enterprise"');
    expect(result.toolExecutions[0]?.resultPreview).toContain('"active":true');
    expect(result.toolExecutions[0]?.resultPreview).toContain(
      '"observed_at":{"$schemanautType":"datetime","value":"2026-03-01T10:00:00.000Z"}',
    );
    for (const serialized of [
      serializedSession,
      secondCallContext,
      persistedEvidence,
      JSON.stringify(result.toolExecutions),
    ]) {
      expect(serialized).toContain(businessLabel);
      expect(serialized).toContain(regionCode);
      expect(serialized).toContain(opaquePayload);
      expect(serialized).toContain('opaque_payload');
      expect(serialized).not.toContain(apiKey);
      expect(serialized).toContain('[REDACTED]');
    }
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
      mode: 'read',
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
      {
        type: 'run_started',
        sessionId: 'session_test',
        mode: 'read',
        allowedTools: ['query_database'],
      },
      {
        type: 'model_call_started',
        iteration: 1,
        providerId: 'fake',
        model: 'fake-model',
        toolCount: 1,
      },
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
    expect(toolStarted?.argumentPreview).toContain('"apiKey":"[REDACTED]"');
    expect(serialized).not.toContain(apiKey);
  });

  it('blocks non-readonly tools in read mode before side effects happen', async () => {
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
            toolCalls: [
              { id: 'call_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } },
            ],
          },
          {
            text: '该写入未获许可，因此没有执行。',
            toolCalls: [],
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
      mode: 'read',
    });

    expect(result.status).toBe('done');
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
      { type: 'model_call_started', iteration: 2 },
      { type: 'model_call_finished', iteration: 2, toolCallCount: 0 },
      { type: 'run_finished', status: 'done' },
    ]);
  });

  it('does not execute read-mode medium tools without an approval provider', async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'execute_maintenance_action',
        description: 'Execute a database maintenance action',
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
            toolCalls: [
              {
                id: 'call_action',
                name: 'execute_maintenance_action',
                arguments: { action: 'vacuum' },
              },
            ],
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
      mode: 'read',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(executed).toBe(false);
    expect(result.toolExecutions).toMatchObject([
      { status: 'denied', resultPreview: 'Permission: ask' },
    ]);
    expect(result.finalText).toBe('需要用户批准后才能写入文件。');
  });

  it('passes approval provenance to tools only after the approval provider allows execution', async () => {
    let approvalSeen: AgentToolApproval | undefined;
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
            toolCalls: [
              { id: 'call_write', name: 'execute_sql', arguments: { sql: 'delete from orders' } },
            ],
          },
          {
            text: '已执行。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      () => ({
        approved: true,
        requestId: 'approval_1',
        approvedAt: '2026-07-10T01:00:00.000Z',
        approvedBy: 'tester',
        reason: '业务确认',
      }),
      { ...fixedDependencies(), auditLog },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单',
      mode: 'read',
      maxIterations: 2,
    });

    expect(result.status).toBe('done');
    expect(approvalSeen).toMatchObject({
      granted: true,
      source: 'approval-provider',
      toolCallId: 'call_write',
      toolName: 'execute_sql',
      requestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:00.000Z',
      approvedBy: 'tester',
    });
    expect(result.toolExecutions[0]?.approval).toEqual({
      source: 'approval-provider',
      requestId: 'approval_1',
      approvedAt: '2026-07-10T01:00:00.000Z',
      approvedBy: 'tester',
      reason: '业务确认',
    });
    const events = await auditLog.readAll();
    expect(events.find((event) => event.type === 'tool_call_finished')).toMatchObject({
      approval: { requestId: 'approval_1', approvedBy: 'tester' },
    });
  });

  it('scopes an approval to one Tool Call and asks again for the next call in the same Session', async () => {
    const executedCalls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'sql_execute',
        description: 'Execute row changes',
        inputSchema: { type: 'object' },
        dangerLevel: 'high',
        requiredPermission: 'edit',
      },
      (_args, context) => {
        executedCalls.push(context.invocation?.toolCallId ?? 'missing');
        return { ok: true };
      },
    );
    let approvalCount = 0;
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              {
                id: 'update-approved',
                name: 'sql_execute',
                arguments: { sql: 'UPDATE orders SET amount = 1 WHERE id = 1' },
              },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'update-not-approved',
                name: 'sql_execute',
                arguments: { sql: 'UPDATE orders SET amount = 2 WHERE id = 1' },
              },
            ],
          },
          {
            text: 'Only the first update was approved.',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      () => {
        approvalCount += 1;
        return approvalCount === 1;
      },
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Run two updates after asking for each one.',
      mode: 'read',
      maxIterations: 3,
    });

    expect(approvalCount).toBe(2);
    expect(executedCalls).toEqual(['update-approved']);
    expect(result.toolExecutions).toMatchObject([
      {
        toolCallId: 'update-approved',
        status: 'success',
        approval: { source: 'approval-provider' },
      },
      {
        toolCallId: 'update-not-approved',
        status: 'denied',
      },
    ]);
    expect(result.toolExecutions[1]).not.toHaveProperty('approval');
  });

  it('waits for a broker approval request before executing read-mode tools', async () => {
    let executed = false;
    let approvalSeen: AgentToolApproval | undefined;
    const broker = new AgentToolApprovalBroker({
      now: sequenceNow(['2026-07-10T01:00:00.000Z', '2026-07-10T01:00:02.000Z']),
      createRequestId: () => 'approval_pending',
      approvalTimeoutMs: 5_000,
    });
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
        executed = true;
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
            toolCalls: [
              {
                id: 'call_write',
                name: 'execute_sql',
                arguments: { sql: 'delete from orders', password: 'secret-pass' },
              },
            ],
          },
          {
            text: '已执行。',
            toolCalls: [],
          },
        ]),
      ]),
      registry,
      usage,
      broker.createProvider(),
      fixedDependencies(),
    );

    const runPromise = agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单',
      mode: 'read',
      maxIterations: 2,
    });

    await waitFor(() => broker.listPending().length === 1);
    expect(executed).toBe(false);
    expect(broker.listPending()[0]).toMatchObject({
      id: 'approval_pending',
      toolCallId: 'call_write',
      toolName: 'execute_sql',
    });
    expect(typeof broker.listPending()[0]?.sessionId).toBe('string');
    expect(broker.listPending()[0]?.argumentPreview).not.toContain('secret-pass');

    broker.approve('approval_pending', { resolvedBy: 'tester', reason: '人工确认' });
    const result = await runPromise;

    expect(result.status).toBe('done');
    expect(executed).toBe(true);
    expect(approvalSeen).toMatchObject({
      requestId: 'approval_pending',
      approvedBy: 'tester',
      reason: '人工确认',
    });
    expect(result.toolExecutions[0]?.approval).toMatchObject({
      requestId: 'approval_pending',
      approvedBy: 'tester',
      reason: '人工确认',
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
            toolCalls: [
              {
                id: 'bad_sql',
                name: 'query_database',
                arguments: { sql: 'select missing_column from orders' },
              },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'fixed_sql',
                name: 'query_database',
                arguments: { sql: 'select count(*) as order_count from orders' },
              },
            ],
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
      mode: 'read',
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
    let toolCleanupFinished = false;
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
        return new Promise((resolve) => {
          context.signal?.addEventListener('abort', () => {
            toolSignalAborted = true;
            setTimeout(() => {
              toolCleanupFinished = true;
              resolve({ cancelled: true });
            }, 10);
          });
        });
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              {
                id: 'slow_query',
                name: 'query_database',
                arguments: { sql: 'select pg_sleep(60)' },
              },
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
      mode: 'read',
      maxIterations: 2,
      maxToolExecutionMs: 5,
    });

    expect(result.status).toBe('done');
    expect(toolSignalAborted).toBe(true);
    expect(toolCleanupFinished).toBe(true);
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

  it('uses the failure threshold to trigger recovery instead of stopping the task', async () => {
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
              {
                id: 'slow_query',
                name: 'query_database',
                arguments: { sql: 'select pg_sleep(60)' },
              },
            ],
          },
          {
            text: '查询超时；请缩小时间范围后继续。',
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
      mode: 'read',
      maxIterations: 10,
      maxConsecutiveToolFailures: 1,
      maxToolExecutionMs: 5,
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(2);
    expect(result.finalText).toContain('查询超时');
    await expect(checkpointStore.listBySession('session_test')).resolves.toMatchObject([
      {
        iteration: 1,
        status: 'running',
      },
      { iteration: 2, status: 'done' },
    ]);
    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 1 });
  });

  it('changes approach after repeated tool failures and can still finish honestly', async () => {
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
            toolCalls: [
              {
                id: 'fail_1',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'fail_2',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'fail_3',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
          },
          {
            text: '数据库连接持续重置，请恢复连接后在当前会话继续。',
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
      mode: 'read',
      maxIterations: 10,
    });

    expect(result.status).toBe('done');
    expect(result.iterations).toBe(4);
    expect(result.finalText).toContain('恢复连接');
    expect(result.toolExecutions).toMatchObject([
      { toolCallId: 'fail_1', status: 'failed' },
      { toolCallId: 'fail_2', status: 'failed' },
      { toolCallId: 'fail_3', status: 'failed' },
    ]);
    await expect(checkpointStore.listBySession('session_test')).resolves.toMatchObject([
      { iteration: 1, status: 'running' },
      { iteration: 2, status: 'running' },
      { iteration: 3, status: 'running' },
      { iteration: 4, status: 'done' },
    ]);
    await expect(checkpointStore.listRecoverable()).resolves.toEqual([]);
    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 1 });
    await expect(usage.roundHistory()).resolves.toMatchObject([
      { sessionId: 'session_test', status: 'success' },
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
        if (String(args.sql).includes('bad_column'))
          throw new Error('column bad_column does not exist');
        return { rows: [{ order_count: 42 }] };
      },
    );
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              {
                id: 'bad_sql',
                name: 'query_database',
                arguments: { sql: 'select bad_column from orders' },
              },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'fixed_sql',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
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
      mode: 'read',
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
      mode: 'read',
    });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('订单总数是 42。');
    await expect(streamStore.listRecoverable()).resolves.toEqual([]);
    await expect(streamStore.listBySession('session_test')).resolves.toMatchObject([
      {
        status: 'complete',
        sessionId: 'session_test',
        roundId: 'round_test',
        providerId: 'streaming',
        model: 'fake-stream-model',
        text: '订单总数是 42。',
        chunks: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
      },
    ]);
    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 1, totalTokens: 16 });
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
        mode: 'read',
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
    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 0 });
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
      mode: 'read',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(['query_database']);
  });

  it('compresses long conversation context before model calls', async () => {
    const auditLog = new AgentAuditLogStore(await auditPath());
    const usage = new UsageTracker(await usagePath());
    const calls: LlmChatRequest[] = [];
    let normalCall = 0;
    const provider: LlmProvider = {
      id: 'fake',
      name: 'Fake Provider',
      mode: 'byok',
      chat(request) {
        calls.push(request);
        if (request.metadata?.purpose === 'context-compaction') {
          return Promise.resolve({
            text: [
              '## Goal',
              '分析订单。',
              '## Database facts and SQL',
              'orders.amount 是金额列，之前查询均为只读。',
              '## Current state',
              '继续处理最新用户任务。',
            ].join('\n'),
            toolCalls: [],
            usage: {
              promptTokens: 300,
              completionTokens: 80,
              totalTokens: 380,
            },
          });
        }
        normalCall += 1;
        if (normalCall === 1) {
          return Promise.resolve({
            text: '',
            toolCalls: [
              {
                id: 'large_result',
                name: 'query_database',
                arguments: { sql: 'select * from orders' },
              },
            ],
          });
        }
        return Promise.resolve({
          text: '已基于摘要继续分析。',
          toolCalls: [],
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const router = new LlmRouter(usage, [provider]);
    router.gateway.registerModel({
      providerId: 'fake',
      model: 'fake-model',
      limits: { contextTokens: 8_000, maxOutputTokens: 4_096 },
    });
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
        rows: Array.from({ length: 200 }, (_, index) => ({ id: index, amount: index * 10 })),
      }),
    );
    const agent = new ReactAgent(router, registry, usage, undefined, {
      ...fixedDependencies(),
      auditLog,
    });

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '分析所有订单明细',
      mode: 'read',
      initialSession: longRestoredSession(),
      maxIterations: 2,
      keepRecentMessages: 4,
      maxToolResultChars: 240,
    });

    expect(result.status).toBe('done');
    const compactionCalls = calls.filter((call) => call.metadata?.purpose === 'context-compaction');
    const agentCalls = calls.filter((call) => call.metadata?.purpose !== 'context-compaction');
    expect(compactionCalls.length).toBeGreaterThan(0);
    expect(agentCalls).toHaveLength(2);
    expect(result.contextCompression).toHaveLength(2);
    expect(result.contextCompression?.[0]).toMatchObject({
      trigger: 'auto',
      level: 'conversation-checkpoint',
      activeCheckpointSequence: 1,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      steps: expect.arrayContaining([expect.objectContaining({ type: 'conversation-checkpoint' })]),
    });
    expect(result.contextCompression?.[0]?.phase).toBe('compacted');
    expect(result.session.contextCheckpoint).toMatchObject({
      sequence: 1,
      trigger: 'auto',
      method: 'model',
    });
    await expect(auditLog.readAll()).resolves.toContainEqual(
      expect.objectContaining({
        type: 'context_compaction_applied',
        sessionId: 'session_test',
        iteration: 1,
        trigger: 'auto',
      }),
    );
    expect(compactionCalls[0]?.metadata).toMatchObject({
      purpose: 'context-compaction',
      trigger: 'auto',
    });
    expect(compactionCalls[0]?.tools).toBeUndefined();
    expect(
      agentCalls[0]?.messages.some((message) =>
        message.content.includes('<conversation_checkpoint>'),
      ),
    ).toBe(true);
    expect(
      agentCalls[0]?.messages.some((message) => message.content.includes('orders.amount 是金额列')),
    ).toBe(true);
    expect(JSON.stringify(agentCalls[0]?.messages)).not.toContain(
      'coveredConversationMessageCount',
    );
  });

  it('allows users to trigger context compaction manually with a focus', async () => {
    const usage = new UsageTracker(await usagePath());
    const calls: LlmChatRequest[] = [];
    const provider: LlmProvider = {
      id: 'fake',
      name: 'Fake Provider',
      mode: 'byok',
      chat(request) {
        calls.push(request);
        return Promise.resolve({
          text: [
            '## Goal',
            '保留已执行 SQL 与精确金额。',
            '## Actions and results',
            'select sum(amount) from orders 已执行。',
          ].join('\n'),
          toolCalls: [],
          usage: {
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
          },
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const router = new LlmRouter(usage, [provider]);
    router.gateway.registerModel({
      providerId: 'fake',
      model: 'fake-model',
      limits: { contextTokens: 2_000, maxOutputTokens: 300 },
    });
    const agent = new ReactAgent(
      router,
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );
    const session = longRestoredSession();
    const originalMessages = structuredClone(session.messages);

    const result = await agent.compact({
      providerId: 'fake',
      model: 'fake-model',
      session,
      focus: '重点保留已执行 SQL 和精确金额。',
      keepRecentMessages: 4,
    });

    expect(result.status).toBe('compacted');
    expect(result.checkpoint).toMatchObject({
      sequence: 1,
      trigger: 'manual',
      method: 'model',
      focus: '重点保留已执行 SQL 和精确金额。',
    });
    expect(result.session.messages).toEqual(originalMessages);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.messages[1]?.content).toContain('<manual_focus>');
    expect(calls.every((call) => !JSON.stringify(call.messages).includes('call_internal_'))).toBe(
      true,
    );
  });

  it('continues with a deterministic checkpoint when the compaction model returns no summary', async () => {
    const usage = new UsageTracker(await usagePath());
    const calls: LlmChatRequest[] = [];
    const provider: LlmProvider = {
      id: 'fake',
      name: 'Fake Provider',
      mode: 'byok',
      chat(request) {
        calls.push(request);
        if (request.metadata?.purpose === 'context-compaction') {
          return Promise.resolve({ text: '', toolCalls: [] });
        }
        return Promise.resolve({
          text: '已从恢复检查点继续处理。',
          toolCalls: [],
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const router = new LlmRouter(usage, [provider]);
    router.gateway.registerModel({
      providerId: 'fake',
      model: 'fake-model',
      limits: { contextTokens: 8_000, maxOutputTokens: 4_096 },
    });
    const agent = new ReactAgent(
      router,
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '继续分析订单。',
      mode: 'read',
      initialSession: longRestoredSession(),
      maxIterations: 1,
      keepRecentMessages: 4,
    });

    expect(result.status).toBe('done');
    expect(result.session.contextCheckpoint).toMatchObject({
      sequence: 1,
      trigger: 'auto',
      method: 'deterministic-fallback',
    });
    expect(result.contextCompression).toBeDefined();
    if (!result.contextCompression) {
      throw new Error('Expected an automatic context compression report.');
    }
    expect(result.contextCompression[0]?.warnings).toContain(
      'The model summary failed, so a deterministic recovery checkpoint was used.',
    );
    const normalCall = calls.find((call) => call.metadata?.purpose !== 'context-compaction');
    expect(
      normalCall?.messages.some((message) =>
        message.content.includes('Goal and user requirements'),
      ),
    ).toBe(true);
    expect(result.session.contextCheckpoint?.summary).not.toContain('call_internal_');
  });

  it('carries the previous semantic checkpoint into a later automatic compaction', async () => {
    const usage = new UsageTracker(await usagePath());
    const calls: LlmChatRequest[] = [];
    let compactionCall = 0;
    const provider: LlmProvider = {
      id: 'fake',
      name: 'Fake Provider',
      mode: 'byok',
      chat(request) {
        calls.push(request);
        if (request.metadata?.purpose === 'context-compaction') {
          compactionCall += 1;
          return Promise.resolve({
            text:
              compactionCall === 1
                ? '## Current state\nPHASE_ONE：orders.amount 已确认。'
                : '## Current state\nPHASE_ONE 与 PHASE_TWO_EXACT_1726_50 均已确认。',
            toolCalls: [],
            usage: {
              promptTokens: 400,
              completionTokens: 80,
              totalTokens: 480,
            },
          });
        }
        return Promise.resolve({
          text: '已基于累计检查点继续。',
          toolCalls: [],
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const router = new LlmRouter(usage, [provider]);
    router.gateway.registerModel({
      providerId: 'fake',
      model: 'fake-model',
      limits: { contextTokens: 12_000, maxOutputTokens: 4_096 },
    });
    const agent = new ReactAgent(
      router,
      registryWithQueryTool(),
      usage,
      undefined,
      fixedDependencies(),
    );
    const first = await agent.compact({
      providerId: 'fake',
      model: 'fake-model',
      session: longRestoredSession(),
      keepRecentMessages: 2,
    });
    expect(first.status).toBe('compacted');
    const phaseTwoSession = first.session;
    for (let index = 1; index <= 30; index += 1) {
      appendMessage(
        phaseTwoSession,
        createMessage(
          {
            role: index % 2 === 0 ? 'assistant' : 'user',
            content: `PHASE_TWO_EXACT_1726_50 round ${index}: ${'新阶段数据库事实。'.repeat(45)}`,
          },
          fixedDependencies().now,
        ),
      );
    }

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '继续第二阶段分析。',
      mode: 'read',
      initialSession: phaseTwoSession,
      maxIterations: 1,
      keepRecentMessages: 4,
    });

    expect(result.status).toBe('done');
    expect(result.session.contextCheckpoint?.sequence).toBe(2);
    expect(result.session.contextCheckpoint?.trigger).toBe('auto');
    expect(result.session.contextCheckpoint?.method).toBe('model');
    expect(result.session.contextCheckpoint?.summary).toContain('PHASE_TWO_EXACT_1726_50');
    const automaticCompactionCalls = calls.filter(
      (call) =>
        call.metadata?.purpose === 'context-compaction' && call.metadata?.trigger === 'auto',
    );
    expect(automaticCompactionCalls.length).toBeGreaterThan(0);
    expect(
      automaticCompactionCalls[0]?.messages.some((message) =>
        message.content.includes('<previous_checkpoint>'),
      ),
    ).toBe(true);
    expect(
      automaticCompactionCalls.some((call) =>
        call.messages.some((message) => message.content.includes('PHASE_TWO_EXACT_1726_50')),
      ),
    ).toBe(true);
    const normalCalls = calls.filter((call) => call.metadata?.purpose !== 'context-compaction');
    const normalCall = normalCalls[normalCalls.length - 1];
    expect(
      normalCall?.messages.some((message) =>
        message.content.includes('PHASE_ONE 与 PHASE_TWO_EXACT_1726_50'),
      ),
    ).toBe(true);
    expect(result.session.messages.length).toBe(phaseTwoSession.messages.length + 2);
  });

  it('bounds large tool results before persisting them into the session and model context', async () => {
    const usage = new UsageTracker(await usagePath());
    const { provider, calls } = scriptedProviderWithCalls([
      {
        text: '',
        toolCalls: [
          {
            id: 'large_export',
            name: 'query_database',
            arguments: { sql: 'select * from event_logs' },
          },
        ],
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
      userMessage: 'Analyze a large event log export.',
      mode: 'read',
      maxIterations: 2,
      maxToolResultChars: 260,
    });

    const toolMessage = result.session.messages.find((message) => message.role === 'tool');

    expect(result.status).toBe('done');
    expect(result.toolExecutions[0]?.resultPreview.length).toBeLessThanOrEqual(260);
    expect(result.toolExecutions[0]?.resultPreview).toContain('tool_result_too_large');
    expect(toolMessage?.content.length).toBeLessThanOrEqual(260);
    expect(toolMessage?.content).toContain('tool_result_too_large');
    expect(
      calls[1]?.messages.some((message) => message.content.includes('tool_result_too_large')),
    ).toBe(true);
    expect(
      calls[1]?.messages.some((message) => message.content.includes('large-payload-499')),
    ).toBe(false);
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
            toolCalls: [
              { id: 'hidden_write', name: 'execute_sql', arguments: { sql: 'drop table orders' } },
            ],
          },
          {
            text: '当前工具策略不允许结构变更，因此没有执行。',
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
      userMessage: 'Run a skill that allows readonly query only.',
      mode: 'full',
      allowedTools: ['query_database'],
    });

    expect(result.status).toBe('done');
    expect(writeExecuted).toBe(false);
    expect(result.finalText).toContain('没有执行');
    expect(result.toolExecutions).toMatchObject([
      {
        toolCallId: 'hidden_write',
        toolName: 'execute_sql',
        status: 'denied',
        resultPreview: 'Tool not allowed by run policy.',
      },
    ]);
  });

  it('counts user-aborted Agent rounds without calling the model', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
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
      { ...fixedDependencies(), checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Start then stop.',
      mode: 'read',
      signal,
    });

    expect(result.status).toBe('aborted');
    expect(result.completion).toMatchObject({
      verified: false,
      phase: 'verify',
      unresolvedTaskIds: [],
    });
    expect(calls).toHaveLength(0);
    await expect(checkpointStore.listBySession(result.session.id)).resolves.toMatchObject([
      { iteration: 0, status: 'aborted' },
    ]);
    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 1 });
    await expect(usage.roundHistory()).resolves.toMatchObject([{ status: 'aborted' }]);
  });

  it('marks max-iteration exhaustion as unverified and non-successful', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          {
            text: '',
            toolCalls: [
              {
                id: 'still_working',
                name: 'query_database',
                arguments: { sql: 'select count(*) from orders' },
              },
            ],
          },
        ]),
      ]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: 'Keep investigating until the evidence is complete.',
      mode: 'read',
      maxIterations: 1,
    });

    expect(result.status).toBe('max_iterations_reached');
    expect(result.completion).toMatchObject({
      verified: false,
      phase: 'verify',
      unresolvedTaskIds: [],
    });
    await expect(checkpointStore.listBySession(result.session.id)).resolves.toMatchObject([
      { iteration: 1, status: 'failed' },
    ]);
    await expect(usage.roundHistory()).resolves.toMatchObject([
      { sessionId: result.session.id, status: 'failed' },
    ]);
  });

  it('does not count provider infrastructure failures as completed Agent rounds', async () => {
    const checkpointStore = new AgentCheckpointStore(await checkpointPath());
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [throwingProvider('provider timeout')]),
      registryWithQueryTool(),
      usage,
      undefined,
      { ...fixedDependencies(), checkpointStore },
    );

    await expect(
      agent.run({
        providerId: 'throwing',
        model: 'fake-model',
        userMessage: 'Analyze orders.',
        mode: 'read',
      }),
    ).rejects.toThrow('provider timeout');

    await expect(usage.current()).resolves.toMatchObject({ completedRounds: 0 });
    await expect(usage.roundHistory()).resolves.toMatchObject([
      { sessionId: 'session_test', status: 'failed', errorMessage: 'provider timeout' },
    ]);
    await expect(checkpointStore.listBySession('session_test')).resolves.toMatchObject([
      { iteration: 1, status: 'failed', errorMessage: 'provider timeout' },
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

function scriptedProviderWithCalls(script: LlmChatResponse[]): {
  provider: LlmProvider;
  calls: LlmChatRequest[];
} {
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? values[values.length - 1] ?? '';
}

function longRestoredSession() {
  const session = createAgentSession({
    id: 'session_test',
    title: 'Long restored session',
    mode: 'read',
    now: fixedDependencies().now,
  });
  appendMessage(
    session,
    createMessage({ role: 'user', content: 'Restore previous analysis.' }, fixedDependencies().now),
  );
  for (let index = 1; index <= 10; index += 1) {
    appendMessage(
      session,
      createMessage(
        {
          role: 'assistant',
          content: `Previous analysis round ${index}.`,
          toolCalls: [
            {
              id: `call_internal_${index}`,
              name: 'query_database',
              arguments: {
                sql: `select ${index} as round_no, sum(amount) from orders`,
              },
            },
          ],
        },
        fixedDependencies().now,
      ),
    );
    appendMessage(
      session,
      createMessage(
        {
          role: 'tool',
          toolCallId: `call_internal_${index}`,
          toolName: 'query_database',
          content: JSON.stringify({
            round: index,
            amount: index * 100,
            rows: Array.from({ length: 12 }, (_, row) => ({
              id: row,
              payload: 'x'.repeat(80),
            })),
          }),
        },
        fixedDependencies().now,
      ),
    );
  }
  return session;
}
