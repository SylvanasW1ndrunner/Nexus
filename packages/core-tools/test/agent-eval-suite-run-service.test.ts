import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunOptions, AgentRunResult } from '@dbagent/core-agent';
import { AgentEvalSuiteRunService, type AgentEvalSuiteAgent, type AgentEvalSuite } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentEvalSuiteRunService', () => {
  it('loads a workspace suite from catalog, runs it, and writes source metadata into the report', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, {
      filename: 'run.json',
      suiteId: 'workspace.run',
      suiteName: '工作区运行验收',
      environment: 'integration',
      caseId: 'RUN-001',
    });
    const reportStorePath = join(await tempWorkspace(), 'reports.json');
    const agent = recordingAgent([
      runResult({
        finalText: 'paid_search GMV 已完成。',
        toolExecutions: [
          {
            toolCallId: 'schema_1',
            toolName: 'search_schema',
            status: 'success',
            durationMs: 1,
            argumentPreview: '{"query":"GMV"}',
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

    const output = await new AgentEvalSuiteRunService().run({
      agent,
      suiteId: 'workspace.run',
      catalog: { official: false, workspace: { workspaceRoot: rootPath } },
      reportStorePath,
      generatedAt: '2026-07-06T00:00:00.000Z',
      reportRun: { live: true, commit: 'test-commit' },
      baseRun: {
        providerId: 'fake',
        model: 'fake-model',
        mode: 'readonly',
        maxIterations: 5,
      },
    });

    expect(output.summary).toMatchObject({ totalCases: 1, passedCases: 1, failedCases: 0 });
    expect(output.catalogEntry).toMatchObject({
      suiteId: 'workspace.run',
      source: { kind: 'workspace', relativePath: '.dbagent/evals/run.json' },
    });
    expect(output.suiteSource).toEqual({ kind: 'workspace', relativePath: '.dbagent/evals/run.json' });
    expect(output.report.suiteSource).toEqual({ kind: 'workspace', relativePath: '.dbagent/evals/run.json' });
    expect(output.report.run).toMatchObject({ providerId: 'fake', model: 'fake-model', live: true, commit: 'test-commit' });
    expect(output.savedReport).toMatchObject({ suiteId: 'workspace.run', passRate: 1 });
    expect(agent.calls).toMatchObject([
      {
        providerId: 'fake',
        model: 'fake-model',
        mode: 'readonly',
        maxIterations: 5,
        userMessage: '按渠道统计 GMV、退款率和 ROI。',
      },
    ]);
  });

  it('rejects PostgreSQL suites unless the caller explicitly enables real PostgreSQL execution', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, {
      filename: 'postgres.json',
      suiteId: 'workspace.postgres',
      environment: 'postgres',
      caseId: 'PG-001',
    });
    const agent = recordingAgent([]);

    await expect(
      new AgentEvalSuiteRunService().run({
        agent,
        suiteId: 'workspace.postgres',
        catalog: { official: false, workspace: { workspaceRoot: rootPath } },
        baseRun: { providerId: 'fake', model: 'fake-model', mode: 'readonly' },
      }),
    ).rejects.toThrow('requires PostgreSQL');
    expect(agent.calls).toEqual([]);
  });

  it('runs PostgreSQL suites when the explicit PostgreSQL gate is open', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, {
      filename: 'postgres-allowed.json',
      suiteId: 'workspace.postgres.allowed',
      environment: 'postgres',
      caseId: 'PG-ALLOWED-001',
    });
    const agent = recordingAgent([
      runResult({
        finalText: 'paid_search',
        toolExecutions: [
          toolExecution('search_schema', 'public.orders'),
          toolExecution('query_database', 'paid_search'),
        ],
      }),
    ]);

    const output = await new AgentEvalSuiteRunService().run({
      agent,
      suiteId: 'workspace.postgres.allowed',
      catalog: { official: false, workspace: { workspaceRoot: rootPath } },
      allowPostgresSuites: true,
      baseRun: { providerId: 'fake', model: 'fake-model', mode: 'readonly' },
    });

    expect(output.report.run.postgres).toBe(true);
    expect(output.summary.failedCases).toBe(0);
    expect(agent.calls).toHaveLength(1);
  });

  it('rejects live LLM suites unless the caller explicitly enables live provider execution', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, {
      filename: 'live.json',
      suiteId: 'workspace.live',
      environment: 'llm-live',
      caseId: 'LIVE-001',
    });
    const agent = recordingAgent([]);

    await expect(
      new AgentEvalSuiteRunService().run({
        agent,
        suiteId: 'workspace.live',
        catalog: { official: false, workspace: { workspaceRoot: rootPath } },
        baseRun: { providerId: 'fake', model: 'fake-model', mode: 'readonly' },
      }),
    ).rejects.toThrow('requires a live LLM provider');
    expect(agent.calls).toEqual([]);
  });

  it('returns a clear error when the selected suite is not in the catalog', async () => {
    const agent = recordingAgent([]);

    await expect(
      new AgentEvalSuiteRunService().run({
        agent,
        suiteId: 'missing.suite',
        catalog: { official: false },
        baseRun: { providerId: 'fake', model: 'fake-model' },
      }),
    ).rejects.toThrow('Agent eval suite is not available: missing.suite.');
    expect(agent.calls).toEqual([]);
  });
});

function recordingAgent(script: AgentRunResult[]): AgentEvalSuiteAgent & { calls: AgentRunOptions[] } {
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
      id: 'session_eval_run_service',
      title: 'eval run service',
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

function toolExecution(toolName: string, resultPreview: string): AgentRunResult['toolExecutions'][number] {
  return {
    toolCallId: `${toolName}_1`,
    toolName,
    status: 'success',
    durationMs: 1,
    argumentPreview: '{}',
    resultPreview,
  };
}

async function tempWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-eval-run-service-'));
  tempDirs.push(rootPath);
  return rootPath;
}

async function writeWorkspaceManifest(
  rootPath: string,
  input: {
    filename: string;
    suiteId: string;
    suiteName?: string;
    environment: NonNullable<AgentEvalSuite['environment']>;
    caseId: string;
  },
): Promise<void> {
  await mkdir(join(rootPath, '.dbagent', 'evals'), { recursive: true });
  await writeFile(
    join(rootPath, '.dbagent', 'evals', input.filename),
    JSON.stringify(
      {
        version: 1,
        suite: {
          suiteId: input.suiteId,
          suiteName: input.suiteName ?? `Workspace ${input.suiteId}`,
          environment: input.environment,
          notes: ['工作区运行套件不包含 provider、model 或 secret。'],
          cases: [
            {
              id: input.caseId,
              userTask: '按渠道统计 GMV、退款率和 ROI。',
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
                  caseSensitive: false,
                  resultIncludes: ['paid_search'],
                },
              ],
              finalTextExcludes: ['password', 'secret', 'api_key'],
              run: {
                allowedTools: ['search_schema', 'query_database'],
                mode: 'readonly',
                maxIterations: 5,
              },
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}
