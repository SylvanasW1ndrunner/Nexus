import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEvalSuiteCatalogService } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentEvalSuiteCatalogService', () => {
  it('lists official and workspace eval suites as safe summaries by default', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'business.json', 'workspace.business', 'BUSINESS-001');

    const service = new AgentEvalSuiteCatalogService();
    const result = await service.list({
      official: { enabledPluginIds: ['official.agent-rag-eval'] },
      workspace: { workspaceRoot: rootPath },
    });

    expect(result.totalCount).toBe(2);
    expect(result.entries.map((entry) => entry.suiteId)).toEqual([
      'official.agent-rag.business-readonly',
      'workspace.business',
    ]);
    expect(result.entries[0]).toMatchObject({
      sourceLabel: 'official:official.agent-rag-eval',
      caseCount: 1,
      requiredToolNames: ['query_database', 'search_schema'],
      allowedToolNames: ['query_database', 'search_schema'],
      runModes: ['readonly'],
      readonlyOnly: true,
    });
    expect(result.entries[1]).toMatchObject({
      sourceLabel: 'workspace:.dbagent/evals/business.json',
      environment: 'postgres',
      caseIds: ['BUSINESS-001'],
      notes: ['工作区评测套件不包含 provider、model 或 secret。'],
    });
    expect(result.entries[0]).not.toHaveProperty('manifest');
    expect(result.entries[0]).not.toHaveProperty('suite');
  });

  it('filters by suite id, source kind and environment without executing the suite', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'traffic.json', 'workspace.traffic', 'TRAFFIC-001');

    const service = new AgentEvalSuiteCatalogService({
      official: { enabledPluginIds: ['official.agent-rag-eval'] },
      workspace: { workspaceRoot: rootPath },
    });
    const result = await service.list({
      suiteIds: ['workspace.traffic'],
      sourceKinds: ['workspace'],
      environments: ['postgres'],
    });

    expect(result).toMatchObject({
      totalCount: 1,
      entries: [
        {
          suiteId: 'workspace.traffic',
          source: { kind: 'workspace', relativePath: '.dbagent/evals/traffic.json' },
          declaredToolNames: ['query_database', 'search_schema'],
        },
      ],
    });
  });

  it('returns detail payloads only when callers explicitly request them', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'detail.json', 'workspace.detail', 'DETAIL-001');

    const service = new AgentEvalSuiteCatalogService({ official: false, workspace: { workspaceRoot: rootPath } });
    const summary = await service.get({ suiteId: 'workspace.detail' });
    const detail = await service.get({ suiteId: 'workspace.detail', includeManifest: true, includeSuite: true });

    expect(summary).not.toHaveProperty('manifest');
    expect(summary).not.toHaveProperty('suite');
    expect(detail?.manifest?.suite.suiteId).toBe('workspace.detail');
    expect(detail?.suite?.cases[0]?.case.id).toBe('DETAIL-001');
  });

  it('clones detail payloads so callers cannot mutate later service queries', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'clone.json', 'workspace.clone', 'CLONE-001');

    const service = new AgentEvalSuiteCatalogService({ official: false, workspace: { workspaceRoot: rootPath } });
    const first = await service.get({ suiteId: 'workspace.clone', includeManifest: true, includeSuite: true });
    first!.manifest!.suite.suiteId = 'mutated';
    first!.suite!.cases[0]!.case.id = 'MUTATED';

    const second = await service.get({ suiteId: 'workspace.clone', includeManifest: true, includeSuite: true });

    expect(second?.manifest?.suite.suiteId).toBe('workspace.clone');
    expect(second?.suite?.cases[0]?.case.id).toBe('CLONE-001');
  });

  it('returns undefined when a suite id is not present', async () => {
    const service = new AgentEvalSuiteCatalogService({ official: false });

    await expect(service.get({ suiteId: 'missing.suite' })).resolves.toBeUndefined();
  });
});

async function tempWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-eval-catalog-service-'));
  tempDirs.push(rootPath);
  return rootPath;
}

async function writeWorkspaceManifest(
  rootPath: string,
  filename: string,
  suiteId: string,
  caseId: string,
): Promise<void> {
  await mkdir(join(rootPath, '.dbagent', 'evals'), { recursive: true });
  await writeFile(
    join(rootPath, '.dbagent', 'evals', filename),
    JSON.stringify(
      {
        version: 1,
        suite: {
          suiteId,
          suiteName: `Workspace ${suiteId}`,
          environment: 'postgres',
          notes: ['工作区评测套件不包含 provider、model 或 secret。'],
          cases: [
            {
              id: caseId,
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
                  argumentIncludes: ['select'],
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
