import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentEvalSuiteCatalog } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadAgentEvalSuiteCatalog', () => {
  it('loads enabled official suites and workspace suites into one source-aware catalog', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'team-business.json', 'workspace.team.business', 'TEAM-001');

    const catalog = await loadAgentEvalSuiteCatalog({
      official: { enabledPluginIds: ['official.agent-rag-eval'] },
      workspace: { workspaceRoot: rootPath },
    });

    expect(catalog.entries.map((entry) => entry.suiteId)).toEqual([
      'official.agent-rag.business-readonly',
      'workspace.team.business',
    ]);
    expect(catalog.entries[0]).toMatchObject({
      source: { kind: 'official', pluginId: 'official.agent-rag-eval' },
      suiteName: '官方 Agent/RAG 业务只读验收',
    });
    expect(catalog.entries[1]).toMatchObject({
      source: { kind: 'workspace', relativePath: '.dbagent/evals/team-business.json' },
      suiteName: 'Workspace workspace.team.business',
      environment: 'postgres',
      suite: {
        cases: [
          {
            case: {
              id: 'TEAM-001',
              requiredToolCalls: ['search_schema', 'query_database'],
            },
          },
        ],
      },
    });
  });

  it('does not expose disabled-by-default official eval suites unless explicitly enabled', async () => {
    await expect(loadAgentEvalSuiteCatalog()).resolves.toEqual({ entries: [] });
  });

  it('can load only workspace suites when official suites are disabled', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'team-only.json', 'workspace.only', 'TEAM-ONLY-001');

    const catalog = await loadAgentEvalSuiteCatalog({
      official: false,
      workspace: { workspaceRoot: rootPath },
    });

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      suiteId: 'workspace.only',
      source: { kind: 'workspace', relativePath: '.dbagent/evals/team-only.json' },
    });
  });

  it('rejects duplicate suite ids across official and workspace sources', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(
      rootPath,
      'duplicate-official.json',
      'official.agent-rag.business-readonly',
      'DUP-001',
    );

    await expect(
      loadAgentEvalSuiteCatalog({
        official: { enabledPluginIds: ['official.agent-rag-eval'] },
        workspace: { workspaceRoot: rootPath },
      }),
    ).rejects.toThrow(
      'Duplicate eval suite id official.agent-rag.business-readonly: official plugin official.agent-rag-eval and workspace .dbagent/evals/duplicate-official.json',
    );
  });

  it('returns cloned catalog entries so callers cannot mutate future loads', async () => {
    const rootPath = await tempWorkspace();
    await writeWorkspaceManifest(rootPath, 'clone.json', 'workspace.clone', 'CLONE-001');

    const first = await loadAgentEvalSuiteCatalog({
      official: { enabledPluginIds: ['official.agent-rag-eval'] },
      workspace: { workspaceRoot: rootPath },
    });
    first.entries[0]!.suite.suiteId = 'mutated';
    first.entries[1]!.manifest.suite.suiteId = 'mutated-workspace';

    const second = await loadAgentEvalSuiteCatalog({
      official: { enabledPluginIds: ['official.agent-rag-eval'] },
      workspace: { workspaceRoot: rootPath },
    });

    expect(second.entries.map((entry) => entry.suiteId)).toEqual([
      'official.agent-rag.business-readonly',
      'workspace.clone',
    ]);
  });
});

async function tempWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-eval-catalog-'));
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
          notes: ['工作区验收 suite 不包含 provider、model 或 secret。'],
          cases: [
            {
              id: caseId,
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
