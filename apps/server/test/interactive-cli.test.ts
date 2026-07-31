import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyCliApprovalInput,
  CliTraceRenderer,
  initializeCliProject,
  listCliSessions,
  listCliSkills,
  parseCliPostgresUrl,
  startInteractiveCli,
} from '../src/interactive-cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('SchemaNaut CLI', () => {
  it('shows useful SQL actions by default and clears transient TTY progress before the answer', () => {
    const capture = captureOutput(true);
    const trace = new CliTraceRenderer(capture.output);

    trace.start();
    trace.render({
      id: 'event-1',
      sessionId: 'session-1',
      type: 'sql-prepared',
      message: '正在准备 SQL。',
      sql: 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    expect(capture.text()).toContain('正在准备 SQL');
    expect(capture.text()).toContain(
      'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
    );

    trace.clearBeforeFinal();
    expect(capture.text()).toContain('\u001B[1A');
    expect(capture.text()).toContain('\u001B[2K');
  });

  it('supports disabling action traces and keeps non-TTY logs durable', () => {
    const silentCapture = captureOutput(false);
    const silent = new CliTraceRenderer(silentCapture.output);
    silent.setEnabled(false);
    silent.start();
    silent.render({
      id: 'event-1',
      sessionId: 'session-1',
      type: 'exploring',
      message: '正在读取 Schema。',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    expect(silentCapture.text()).toBe('');

    const loggedCapture = captureOutput(false);
    const logged = new CliTraceRenderer(loggedCapture.output);
    logged.start();
    logged.render({
      id: 'event-2',
      sessionId: 'session-1',
      type: 'exploring',
      message: '正在读取 Schema。',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    const beforeClear = loggedCapture.text();
    logged.clearBeforeFinal();
    expect(loggedCapture.text()).toBe(beforeClear);
    expect(beforeClear).toContain('正在读取 Schema');
  });

  it('distinguishes one-call approval, rejection, and a new steering request', () => {
    expect(['y', 'yes', '允许'].map(classifyCliApprovalInput)).toEqual([
      'approve',
      'approve',
      'approve',
    ]);
    expect(['', 'n', 'no', '拒绝'].map(classifyCliApprovalInput)).toEqual([
      'reject',
      'reject',
      'reject',
      'reject',
    ]);
    expect(classifyCliApprovalInput('改成只看最近 7 天')).toBe('steer');
  });

  it('creates and initializes a new project directory without writing credentials', async () => {
    const directory = join(await temporaryDirectory(), 'new-project');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await initializeCliProject(directory);

    expect((await stat(join(directory, '.schemanaut', 'skills'))).isDirectory()).toBe(true);
    expect((await stat(join(directory, 'sql'))).isDirectory()).toBe(true);
    const settings = await readFile(join(directory, '.schemanaut', 'settings.json'), 'utf8');
    const mcp = await readFile(join(directory, '.schemanaut', 'mcp.json'), 'utf8');
    expect(settings).toBe(`${JSON.stringify({ version: 1 }, null, 2)}\n`);
    expect(mcp).toBe(`${JSON.stringify({ version: 1, servers: [] }, null, 2)}\n`);
    expect(`${settings}${mcp}`).not.toMatch(/api.?key|password|token|secret/i);
  });

  it('lists system and project SKILL.md entries with project precedence', async () => {
    const directory = await temporaryDirectory();
    await initializeCliProject(directory);
    const skillDirectory = join(directory, '.schemanaut', 'skills', 'project-query');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: project-query',
        'description: Project-specific query guidance.',
        '---',
        '',
        'Always filter deleted_at IS NULL.',
      ].join('\n'),
      'utf8',
    );

    const skills = await listCliSkills({
      projectDirectory: directory,
      env: {
        SCHEMANAUT_STATE_DATABASE_PATH: join(directory, 'state', 'agent.db'),
      },
    });

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'query-and-answer',
          scope: 'system',
        }),
        {
          name: 'project-query',
          description: 'Project-specific query guidance.',
          scope: 'project',
        },
      ]),
    );
  });

  it('uses the global state database rather than creating state inside a project', async () => {
    const directory = await temporaryDirectory();
    await initializeCliProject(directory);

    await expect(
      listCliSessions({
        projectDirectory: directory,
        env: {
          SCHEMANAUT_STATE_DATABASE_PATH: join(directory, 'state', 'agent.db'),
        },
      }),
    ).resolves.toEqual([]);
    await expect(stat(join(directory, '.schemanaut', 'schemanaut.db'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports all required chat configuration without echoing secret values', async () => {
    await expect(
      startInteractiveCli({
        projectDirectory: await temporaryDirectory(),
        env: {
          SCHEMANAUT_LLM_API_KEY: 'sk-never-print-this-secret',
        },
      }),
    ).rejects.toThrow('SCHEMANAUT_LLM_BASE_URL、SCHEMANAUT_LLM_MODEL、SCHEMANAUT_DATABASE_URL');
  });

  it('parses local and remote PostgreSQL URLs without losing encoded credentials', () => {
    expect(
      parseCliPostgresUrl(
        'postgresql://reader%40team:p%40ss%2Fword@db.example.cn:6432/analytics%20warehouse?sslmode=verify-full',
      ),
    ).toEqual({
      name: 'CLI database',
      host: 'db.example.cn',
      port: 6432,
      database: 'analytics warehouse',
      username: 'reader@team',
      password: 'p@ss/word',
      ssl: 'verify-full',
    });
    expect(parseCliPostgresUrl('postgres://local@127.0.0.1/demo')).toEqual({
      name: 'CLI database',
      host: '127.0.0.1',
      port: 5432,
      database: 'demo',
      username: 'local',
    });
  });

  it('rejects unsupported database protocols and unsafe connection options', () => {
    expect(() => parseCliPostgresUrl('mysql://user:password@localhost/demo')).toThrow(
      '仅支持 postgres:// 或 postgresql://',
    );
    expect(() =>
      parseCliPostgresUrl('postgresql://user:password@localhost/demo?sslmode=allow'),
    ).toThrow('sslmode 只接受');
    expect(() =>
      parseCliPostgresUrl('postgresql://user:password@localhost/demo?sslmode=prefer'),
    ).toThrow('sslmode 只接受');
    expect(() => parseCliPostgresUrl('postgresql://localhost/demo')).toThrow(
      '必须包含主机、数据库名和用户名',
    );
    expect(() => parseCliPostgresUrl('postgresql://user:password@localhost:70000/demo')).toThrow(
      '不是有效的 PostgreSQL URL',
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function captureOutput(isTTY: boolean): {
  output: Writable;
  text: () => string;
} {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  Object.assign(output, { isTTY, columns: 120 });
  return { output, text: () => chunks.join('') };
}
