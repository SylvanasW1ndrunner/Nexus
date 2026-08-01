import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createAgentSession,
  isAgentToolResultEnvelope,
} from '@dbagent/core-agent';
import { registerWorkspaceTools } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('workspace tools', () => {
  it('applies an atomic multi-edit patch and returns durable artifact evidence', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, 'service.ts'),
      'export const host = "localhost";\nexport const port = 3000;\n',
      'utf8',
    );
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory });
    const session = createAgentSession({
      id: 'workspace-patch-session',
      title: 'Workspace patch',
      mode: 'edit',
      now: fixedNow,
    });

    const patched = await registry.get('workspace_patch')!.handler(
      {
        path: 'service.ts',
        edits: [
          { oldText: '"localhost"', newText: '"127.0.0.1"' },
          { oldText: '3000', newText: '3721' },
        ],
      },
      { session },
    );

    expect(isAgentToolResultEnvelope(patched)).toBe(true);
    if (!isAgentToolResultEnvelope(patched)) throw new Error('Expected result envelope.');
    expect(patched.modelProjection).toMatchObject({ path: 'service.ts', replacements: 2 });
    expect(patched.completionEvidence).toMatchObject({
      kind: 'artifact',
      deliveryReady: true,
      outcome: 'succeeded',
    });
    await expect(readFile(join(directory, 'service.ts'), 'utf8')).resolves.toContain(
      '"127.0.0.1"',
    );

    const beforeFailure = await readFile(join(directory, 'service.ts'), 'utf8');
    await expect(
      registry.get('workspace_patch')!.handler(
        {
          path: 'service.ts',
          edits: [
            { oldText: '3721', newText: '4000' },
            { oldText: 'missing fragment', newText: 'never written' },
          ],
        },
        { session },
      ),
    ).rejects.toThrow('edit 2');
    await expect(readFile(join(directory, 'service.ts'), 'utf8')).resolves.toBe(beforeFailure);
  });

  it('writes, reads, searches and edits durable Agent artifacts', async () => {
    const directory = await temporaryDirectory();
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory });
    expect(registry.get('shell_run')).toBeUndefined();
    const session = createAgentSession({
      id: 'workspace-session',
      title: 'Workspace',
      mode: 'edit',
      now: fixedNow,
    });
    const context = { session };

    await registry.get('workspace_write')!.handler(
      {
        path: 'sql/revenue.sql',
        content: 'SELECT sum(net_amount) AS revenue FROM orders;\n',
      },
      context,
    );
    const read = (await registry
      .get('workspace_read')!
      .handler({ path: 'sql/revenue.sql' }, context)) as { content: string };
    const search = (await registry
      .get('workspace_search')!
      .handler({ query: 'net_amount' }, context)) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };
    await registry.get('workspace_edit')!.handler(
      {
        path: 'sql/revenue.sql',
        oldText: 'orders',
        newText: 'paid_orders',
      },
      context,
    );

    expect(read.content).toContain('sum(net_amount)');
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]).toMatchObject({
      path: 'sql/revenue.sql',
      line: 1,
    });
    expect(typeof search.matches[0]?.text).toBe('string');
    await expect(readFile(join(directory, 'sql', 'revenue.sql'), 'utf8')).resolves.toContain(
      'paid_orders',
    );
    expect(session.artifacts).toHaveLength(1);
    expect(session.artifacts?.[0]).toMatchObject({
      path: 'sql/revenue.sql',
      mediaType: 'application/sql',
    });
  });

  it('blocks lexical and symbolic-link-independent parent escapes', async () => {
    const directory = await temporaryDirectory();
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory });
    const session = createAgentSession({
      id: 'workspace-session',
      title: 'Workspace',
      mode: 'edit',
      now: fixedNow,
    });

    await expect(
      registry
        .get('workspace_write')!
        .handler({ path: '../outside.sql', content: 'select 1' }, { session }),
    ).rejects.toThrow('escapes the project workspace');
    await expect(
      registry
        .get('workspace_read')!
        .handler({ path: join(directory, 'absolute.sql') }, { session }),
    ).rejects.toThrow('project-relative');
  });

  it('accepts a canonical symlinked workspace root but rejects a link that resolves outside it', async () => {
    const directory = await temporaryDirectory();
    const actualRoot = join(directory, 'actual-root');
    const linkedRoot = join(directory, 'linked-root');
    const outsideRoot = join(directory, 'outside-root');
    await mkdir(actualRoot);
    await mkdir(outsideRoot);
    await writeFile(join(actualRoot, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outsideRoot, 'outside.txt'), 'outside', 'utf8');
    await directoryLink(actualRoot, linkedRoot);
    await directoryLink(outsideRoot, join(actualRoot, 'escape'));

    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: linkedRoot });
    const session = createAgentSession({
      id: 'workspace-symlink-session',
      title: 'Workspace symlink boundary',
      mode: 'read',
      now: fixedNow,
    });

    await expect(
      registry.get('workspace_read')!.handler({ path: 'inside.txt' }, { session }),
    ).resolves.toMatchObject({ path: 'inside.txt', content: 'inside' });
    await expect(
      registry.get('workspace_read')!.handler({ path: 'escape/outside.txt' }, { session }),
    ).rejects.toThrow('escapes the project workspace');
  });

  it('bounds shell output and keeps execution inside the project', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'marker.txt'), 'ok', 'utf8');
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, {
      rootPath: directory,
      maxOutputChars: 64,
      enableShell: true,
    });
    const session = createAgentSession({
      id: 'workspace-session',
      title: 'Workspace',
      mode: 'full',
      now: fixedNow,
    });
    const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(200))"`;

    const result = (await registry
      .get('shell_run')!
      .handler({ command, timeoutMs: 10_000 }, { session })) as {
      exitCode: number;
      stdout: string;
      truncated: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stdout).toContain('bytes omitted');
    expect(result.truncated).toBe(true);
  });

  it('does not pass arbitrary host secrets into an explicitly enabled shell', async () => {
    const directory = await temporaryDirectory();
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory, enableShell: true });
    const session = createAgentSession({
      id: 'workspace-secret-session',
      title: 'Workspace secret boundary',
      mode: 'full',
      now: fixedNow,
    });
    process.env.SCHEMANAUT_TEST_SECRET = 'must-not-reach-child';
    try {
      const command = `"${process.execPath}" -e "process.stdout.write(process.env.SCHEMANAUT_TEST_SECRET || 'absent')"`;
      const result = (await registry
        .get('shell_run')!
        .handler({ command, timeoutMs: 10_000 }, { session })) as {
        stdout: string;
      };
      expect(result.stdout).toBe('absent');
    } finally {
      delete process.env.SCHEMANAUT_TEST_SECRET;
    }
  });

  it('does not start a shell process when its signal is already aborted', async () => {
    const directory = await temporaryDirectory();
    const markerPath = join(directory, 'pre-aborted-marker.txt');
    const scriptPath = join(directory, 'write-marker.mjs');
    await writeFile(
      scriptPath,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'started');\n",
      'utf8',
    );
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory, enableShell: true });
    const session = createAgentSession({
      id: 'workspace-pre-aborted-session',
      title: 'Workspace pre-aborted shell',
      mode: 'full',
      now: fixedNow,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry
        .get('shell_run')!
        .handler(
          { command: shellCommand(scriptPath, markerPath), timeoutMs: 10_000 },
          { session, signal: controller.signal },
        ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates the complete shell process tree when a running command is cancelled', async () => {
    const directory = await temporaryDirectory();
    const fixture = await processTreeFixture(directory, 1_200);
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory, enableShell: true });
    const session = createAgentSession({
      id: 'workspace-cancel-tree-session',
      title: 'Workspace cancelled process tree',
      mode: 'full',
      now: fixedNow,
    });
    const controller = new AbortController();

    const running = registry.get('shell_run')!.handler(
      {
        command: shellCommand(
          fixture.parentScript,
          fixture.childScript,
          fixture.markerPath,
          fixture.readyPath,
          '1200',
        ),
        timeoutMs: 10_000,
      },
      { session, signal: controller.signal },
    );
    await waitForPath(fixture.readyPath);
    controller.abort();
    await running;
    await delay(1_500);

    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('terminates the complete shell process tree after a timeout', async () => {
    const directory = await temporaryDirectory();
    const fixture = await processTreeFixture(directory, 3_500);
    const registry = new ToolRegistry();
    registerWorkspaceTools(registry, { rootPath: directory, enableShell: true });
    const session = createAgentSession({
      id: 'workspace-timeout-tree-session',
      title: 'Workspace timed out process tree',
      mode: 'full',
      now: fixedNow,
    });

    const result = (await registry.get('shell_run')!.handler(
      {
        command: shellCommand(
          fixture.parentScript,
          fixture.childScript,
          fixture.markerPath,
          fixture.readyPath,
          '3500',
        ),
        timeoutMs: 1_500,
      },
      { session },
    )) as { timedOut: boolean };
    expect(result.timedOut).toBe(true);
    await delay(2_300);

    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixedNow(): string {
  return '2026-07-25T00:00:00.000Z';
}

async function directoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function shellCommand(scriptPath: string, ...args: string[]): string {
  return [process.execPath, scriptPath, ...args]
    .map((value) => `"${value.replaceAll('"', '\\"')}"`)
    .join(' ');
}

async function processTreeFixture(
  directory: string,
  childDelayMs: number,
): Promise<{
  parentScript: string;
  childScript: string;
  markerPath: string;
  readyPath: string;
}> {
  const parentScript = join(directory, `tree-parent-${childDelayMs}.mjs`);
  const childScript = join(directory, `tree-child-${childDelayMs}.mjs`);
  const markerPath = join(directory, `tree-marker-${childDelayMs}.txt`);
  const readyPath = join(directory, `tree-ready-${childDelayMs}.txt`);
  await writeFile(
    childScript,
    [
      "import { writeFileSync } from 'node:fs';",
      'const delayMs = Number(process.argv[3]);',
      "setTimeout(() => { writeFileSync(process.argv[2], 'leaked'); }, delayMs);",
      'setTimeout(() => process.exit(0), delayMs + 500);',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    parentScript,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'const child = spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[5]], {',
      "  stdio: 'ignore',",
      '});',
      "writeFileSync(process.argv[4], String(child.pid ?? 'missing'));",
      'setTimeout(() => process.exit(0), Number(process.argv[5]) + 750);',
      '',
    ].join('\n'),
    'utf8',
  );
  return { parentScript, childScript, markerPath, readyPath };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for fixture path: ${path}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
