import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const runLiveModel = process.env.DBAGENT_RUN_SDK_LIVE === '1';

describe.skipIf(!runPostgresTests)('DatabaseAgentRuntime real PostgreSQL integration', () => {
  it('indexes the real catalog and executes an explicitly approved generated query', async () => {
    const provider = new CatalogAwareFakeProvider();
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'deterministic-integration-model',
      createConnectionId: () => 'sdk-postgres-integration',
      createRunId: () => 'sdk-postgres-run',
    });

    await runtime.connect({
      name: 'SDK PostgreSQL integration',
      host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
      port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
      database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
      username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
      password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
    });

    try {
      const index = await runtime.indexSchema();
      expect(index.ready).toBe(true);
      expect(index.tableCount).toBeGreaterThanOrEqual(2);
      expect(index.columnCount).toBeGreaterThanOrEqual(8);

      const generated = await runtime.generate({
        question: '统计每个城市的订单收入，包括没有订单的城市',
      });
      expect(generated.status).toBe('awaiting_execution');
      expect(generated.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: 'public.orders' }),
          expect.objectContaining({ title: 'public.users' }),
        ]),
      );
      expect(provider.lastRequest?.messages.at(-1)?.content).toContain('public.orders');
      expect(provider.lastRequest?.messages.at(-1)?.content).toContain('public.users');

      const executed = await runtime.executeGenerated(generated.runId, { limit: 20 });
      expect(executed.status).toBe('completed');
      expect(executed.execution.columns.map((column) => column.name)).toEqual(['city', 'revenue']);
      expect(executed.execution.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ city: 'Shanghai' }),
          expect.objectContaining({ city: 'Beijing' }),
        ]),
      );
    } finally {
      await runtime.disconnect();
    }
  });
});

describe.skipIf(!runLiveModel)('DatabaseAgentRuntime live model + PostgreSQL integration', () => {
  it('uses a real OpenAI-compatible model to generate and execute a schema-grounded query', async () => {
    const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
    expect(apiKey, '需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY').toBeTruthy();
    const model =
      process.env.TEST_SILICONFLOW_MODEL ??
      process.env.DBAGENT_LLM_MODEL ??
      'deepseek-ai/DeepSeek-V4-Pro';
    const provider = new OpenAICompatibleProvider({
      id: 'sdk-live',
      name: 'SDK live provider',
      apiKey: apiKey!,
      baseUrl: process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
      timeoutMs: 120_000,
      maxRetries: 1,
    });
    const runtime = new DatabaseAgentRuntime({ provider, model });

    await runtime.connect({
      name: 'SDK live PostgreSQL',
      host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
      port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
      database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
      username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
      password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
    });

    try {
      await runtime.indexSchema();
      const generated = await runtime.generate({
        question: '统计每个城市的用户数量，只返回 city 和 user_count 两列，并按 city 升序。',
      });
      expect(generated.status).toBe('awaiting_execution');
      expect(generated.safety).toMatchObject({ blocked: false, riskLevel: 'safe' });
      expect(generated.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: 'public.users' })]),
      );

      const executed = await runtime.executeGenerated(generated.runId, { limit: 20 });
      expect(executed.status).toBe('completed');
      expect(executed.execution.columns.map((column) => column.name)).toEqual([
        'city',
        'user_count',
      ]);
      expect(executed.execution.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ city: 'Beijing' }),
          expect.objectContaining({ city: 'Shanghai' }),
        ]),
      );
    } finally {
      await runtime.disconnect();
    }
  }, 180_000);
});

class CatalogAwareFakeProvider implements LlmProvider {
  readonly id = 'catalog-aware-fake';
  readonly name = 'Catalog-aware fake';
  readonly mode = 'byok' as const;
  lastRequest?: LlmChatRequest;

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.lastRequest = request;
    return Promise.resolve({
      text: JSON.stringify({
        sql: `select
  u.city,
  coalesce(sum(o.total_amount), 0)::numeric(12, 2) as revenue
from public.users u
left join public.orders o on o.user_id = u.id
group by u.city
order by u.city`,
        explanation: '按用户城市左连接订单并汇总收入。',
        assumptions: ['没有订单的城市收入按 0 计算'],
      }),
      toolCalls: [],
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}
