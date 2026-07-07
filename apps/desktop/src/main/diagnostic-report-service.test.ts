import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopDiagnosticReportService, reportDirectoryName, resolveReportFilePath } from './diagnostic-report-service.js';

const tempDirs: string[] = [];

describe('DesktopDiagnosticReportService', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes a redacted diagnostic report directory from real desktop config and logs', async () => {
    const root = await tempDir();
    const userDataDir = join(root, 'user-data');
    const dataDir = join(userDataDir, 'data');
    const logsDir = join(userDataDir, 'logs');
    const reportsDir = join(userDataDir, 'diagnostic-reports');
    await mkdir(dataDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });

    await writeFile(
      join(dataDir, 'ide-settings.json'),
      JSON.stringify({ provider: { apiKey: ['sk', 'diagnosticsecret123456'].join('-') } }),
      'utf8',
    );
    await writeFile(join(dataDir, 'credentials.json'), 'do-not-read-credential-vault-secret', 'utf8');
    await writeFile(
      join(userDataDir, 'main.log'),
      `startup ok\napi call failed for ${['sk', 'standaloneapikey123456'].join('-')}\nauthorization=Bearer abcdefghijklmnopqrstuvwxyz\nquery=select * from customers where phone=13800138000;\n`,
      'utf8',
    );
    await writeFile(
      join(logsDir, 'agent-2026-07-07.jsonl'),
      JSON.stringify({
        type: 'tool_call_started',
        apiKey: ['sk', 'agentdiagnosticsecret123'].join('-'),
        sql: 'select * from orders where user_id=1',
      }),
      'utf8',
    );
    await writeFile(join(logsDir, 'ignored.tmp'), 'should not enter report', 'utf8');
    await writeFile(join(userDataDir, 'crash-2026-07-07.dump'), 'uncaught password=crash-secret', 'utf8');

    const service = new DesktopDiagnosticReportService({
      userDataDir,
      dataDir,
      logsDir,
      reportsDir,
      app: { name: 'DBAgent', version: '0.1.0', commit: 'testcommit' },
      runtime: { platform: 'win32', arch: 'x64', nodeVersion: '24.0.0', electronVersion: '33.0.0' },
    });
    const output = await service.generate({
      generatedAt: '2099-07-07T12:00:00.000Z',
      retentionDays: 36500,
      maxEntryBytes: 1024,
    });
    const files = await readReportFiles(output.reportPath);
    const combined = Array.from(files.values()).join('\n');

    expect(output.artifactKind).toBe('directory');
    expect(output.reportPath).toBe(join(reportsDir, reportDirectoryName('2099-07-07T12:00:00.000Z', output.fileCount)));
    expect(output.summary).toMatchObject({
      configCount: 1,
      logCount: 2,
      crashSnapshotCount: 1,
      omittedCount: 0,
    });
    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('configs/ide-settings.json')).toBe(true);
    expect(files.has('logs/main.log')).toBe(true);
    expect(files.has('logs/agent-2026-07-07.jsonl')).toBe(true);
    expect(files.has('crash/crash-2026-07-07.dump')).toBe(true);
    expect(combined).toContain('Bearer [REDACTED_TOKEN]');
    expect(combined).toContain('[REDACTED_SQL]');
    expect(combined).toContain('[REDACTED_SECRET]');
    expect(combined).toContain('[REDACTED_API_KEY]');
    expect(combined).not.toContain('diagnosticsecret123456');
    expect(combined).not.toContain('agentdiagnosticsecret123');
    expect(combined).not.toContain('standaloneapikey123456');
    expect(combined).not.toContain('13800138000');
    expect(combined).not.toContain('crash-secret');
    expect(combined).not.toContain('do-not-read-credential-vault-secret');
    expect(combined).not.toContain('should not enter report');
  });

  it('handles missing log directories and rejects escaping report file paths', async () => {
    const root = await tempDir();
    const service = new DesktopDiagnosticReportService({
      userDataDir: join(root, 'user-data'),
      dataDir: join(root, 'user-data', 'data'),
      logsDir: join(root, 'user-data', 'logs'),
      app: { name: 'DBAgent', version: '0.1.0' },
    });

    const output = await service.generate({ generatedAt: '2099-07-07T12:00:00.000Z' });

    expect(output.fileCount).toBe(1);
    expect(output.summary).toMatchObject({ configCount: 0, logCount: 0, crashSnapshotCount: 0 });
    expect(() => resolveReportFilePath(join(root, 'report'), '../escape.txt')).toThrow(/escapes report directory/);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-desktop-diagnostic-'));
  tempDirs.push(dir);
  return dir;
}

async function readReportFiles(rootPath: string, prefix = ''): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const entries = await readdir(join(rootPath, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const nested = await readReportFiles(rootPath, relativePath);
      for (const [path, content] of nested) output.set(path.replace(/\\/g, '/'), content);
    } else {
      output.set(relativePath.replace(/\\/g, '/'), await readFile(join(rootPath, relativePath), 'utf8'));
    }
  }
  return output;
}
