import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentBehaviorEvaluationReportStore,
  buildAgentBehaviorEvaluationReport,
  evaluateAgentBehavior,
  type AgentRunResult,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentBehaviorEvaluationReportStore', () => {
  it('saves, updates, lists and loads redacted evaluation reports', async () => {
    const store = new AgentBehaviorEvaluationReportStore(join(await tempDir(), 'reports.json'));
    const apiKey = ['sk', 'store-secret-123456'].join('-');
    const bearerToken = ['token', 'store-secret-123456'].join('-');
    const first = report('report-1', '2026-06-29T00:00:00.000Z', apiKey);
    const second = report('report-2', '2026-06-29T01:00:00.000Z', `Bearer ${bearerToken}`);

    await expect(store.save(first, '2026-06-29T00:01:00.000Z')).resolves.toMatchObject({
      reportId: 'report-1',
      suiteId: 'agent-rag-business',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      passRate: 1,
    });
    await store.save(second, '2026-06-29T01:01:00.000Z');
    await store.save({ ...first, suiteName: 'updated suite' }, '2026-06-29T02:00:00.000Z');

    const list = await store.list();
    expect(list.map((item) => item.reportId)).toEqual(['report-2', 'report-1']);
    expect(list.find((item) => item.reportId === 'report-1')?.suiteName).toBe('updated suite');

    const loaded = await store.load('report-1');
    const serialized = JSON.stringify(loaded);
    expect(serialized).toContain('sk-[REDACTED]');
    expect(serialized).not.toContain(apiKey);
  });

  it('returns empty results when the report index is missing or corrupted', async () => {
    const filePath = join(await tempDir(), 'reports.json');
    const store = new AgentBehaviorEvaluationReportStore(filePath);

    await expect(store.list()).resolves.toEqual([]);
    await writeFile(filePath, '{broken json', 'utf8');
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load('missing')).resolves.toBeUndefined();
  });

});

function report(reportId: string, generatedAt: string, finalText: string) {
  const summary = evaluateAgentBehavior({
    cases: [
      {
        case: {
          id: 'STORE-001',
          userTask: '验证 eval 报告持久化',
          expectedStatus: 'done',
          requiredToolCalls: ['query_database'],
        },
        result: runResult({ finalText }),
      },
    ],
  });

  return buildAgentBehaviorEvaluationReport({
    reportId,
    suiteId: 'agent-rag-business',
    suiteName: 'Agent/RAG 业务验收',
    generatedAt,
    environment: 'llm-live',
    run: { providerId: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Pro', live: true },
    summary,
  });
}

function runResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    status: 'done',
    session: {
      id: 'session_eval_report_store',
      title: 'eval report store',
      mode: 'read',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
    finalText: '',
    iterations: 1,
    toolExecutions: [
      {
        toolCallId: 'call_1',
        toolName: 'query_database',
        status: 'success',
        durationMs: 1,
        resultPreview: '{}',
      },
    ],
    ...overrides,
    runId: overrides.runId ?? 'run-eval-report-store',
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-eval-report-store-'));
  tempDirs.push(dir);
  return dir;
}
