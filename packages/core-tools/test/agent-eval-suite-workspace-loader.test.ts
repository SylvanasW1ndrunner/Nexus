import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkspaceAgentEvalSuiteManifests } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadWorkspaceAgentEvalSuiteManifests', () => {
  it('loads workspace eval suite manifests from .dbagent/evals in deterministic order', async () => {
    const rootPath = await tempWorkspace();
    await writeManifest(rootPath, 'b-suite.json', 'suite-b', 'B-001');
    await writeManifest(rootPath, 'a-suite.json', 'suite-a', 'A-001');
    await writeFile(join(rootPath, '.dbagent', 'evals', 'README.md'), 'ignored', 'utf8');

    const sources = await loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath });

    expect(sources.map((source) => source.relativePath)).toEqual([
      '.dbagent/evals/a-suite.json',
      '.dbagent/evals/b-suite.json',
    ]);
    expect(sources.map((source) => source.suite.suiteId)).toEqual(['suite-a', 'suite-b']);
    expect(sources[0]?.suite.cases[0]).toMatchObject({
      case: {
        id: 'A-001',
        requiredToolCalls: ['search_schema', 'query_database'],
      },
      run: {
        allowedTools: ['search_schema', 'query_database'],
        mode: 'readonly',
      },
    });
  });

  it('returns an empty list when the workspace eval directory does not exist', async () => {
    const rootPath = await tempWorkspace();

    await expect(loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath })).resolves.toEqual([]);
  });

  it('rejects eval directories that escape the workspace or point at a file', async () => {
    const rootPath = await tempWorkspace();
    await writeFile(join(rootPath, 'evals.json'), '{}', 'utf8');

    await expect(
      loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath, evalsDir: '../evals' }),
    ).rejects.toThrow('Workspace path escapes the active workspace.');
    await expect(
      loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath, evalsDir: 'evals.json' }),
    ).rejects.toThrow('Workspace eval manifest directory is not a directory: evals.json');
  });

  it('wraps invalid JSON and manifest validation errors with the source path', async () => {
    const rootPath = await tempWorkspace();
    await mkdir(join(rootPath, '.dbagent', 'evals'), { recursive: true });
    await writeFile(join(rootPath, '.dbagent', 'evals', 'bad-json.json'), '{', 'utf8');

    await expect(loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath })).rejects.toThrow(
      'Failed to load workspace eval manifest .dbagent/evals/bad-json.json:',
    );

    await rm(join(rootPath, '.dbagent', 'evals', 'bad-json.json'));
    await writeFile(
      join(rootPath, '.dbagent', 'evals', 'empty-suite.json'),
      JSON.stringify({ version: 1, suite: { suiteId: 'empty', suiteName: 'Empty', cases: [] } }),
      'utf8',
    );

    await expect(loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath })).rejects.toThrow(
      'Agent eval suite manifest suite must contain at least one case.',
    );
  });

  it('rejects duplicate suite ids across workspace manifests', async () => {
    const rootPath = await tempWorkspace();
    await writeManifest(rootPath, 'one.json', 'duplicate-suite', 'ONE-001');
    await writeManifest(rootPath, 'two.json', 'duplicate-suite', 'TWO-001');

    await expect(loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath })).rejects.toThrow(
      'Duplicate workspace eval suite id duplicate-suite: .dbagent/evals/one.json and .dbagent/evals/two.json',
    );
  });

  it('rejects manifests larger than the configured byte limit', async () => {
    const rootPath = await tempWorkspace();
    await writeManifest(rootPath, 'large.json', 'large-suite', 'LARGE-001');

    await expect(
      loadWorkspaceAgentEvalSuiteManifests({ workspaceRoot: rootPath, maxBytesPerManifest: 16 }),
    ).rejects.toThrow('Workspace eval manifest exceeds 16 bytes: .dbagent/evals/large.json');
  });
});

async function tempWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-eval-workspace-'));
  tempDirs.push(rootPath);
  return rootPath;
}

async function writeManifest(
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
          suiteName: `Suite ${suiteId}`,
          environment: 'integration',
          cases: [
            {
              id: caseId,
              userTask: '按渠道统计 GMV 和 ROI。',
              expectedStatus: 'done',
              requiredToolCalls: ['search_schema', 'query_database'],
              toolExpectations: [
                {
                  toolName: 'query_database',
                  status: 'success',
                  caseSensitive: false,
                  argumentIncludes: ['select'],
                  resultIncludes: ['paid_search'],
                },
              ],
              run: {
                allowedTools: ['search_schema', 'query_database'],
                mode: 'readonly',
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
