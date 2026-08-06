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
import {
  inferEndpointProviderId,
  loadProjectSettings,
  resolveCliConfiguration,
} from '../src/project-settings.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('SchemaNaut CLI', () => {
  it('maps official endpoints to catalog provider identities and leaves relays explicit', () => {
    expect(inferEndpointProviderId('openai-chat', 'https://api.siliconflow.cn/v1')).toBe(
      'siliconflow',
    );
    expect(inferEndpointProviderId('openai-chat', 'https://relay.example/v1')).toBe(
      'custom-endpoint',
    );
    expect(inferEndpointProviderId('ollama', 'http://127.0.0.1:11434')).toBe('ollama');
  });

  it('loads one project generation configuration and lets explicit environment values override it', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, '.schemanaut'), { recursive: true });
    await writeFile(
      join(directory, '.schemanaut', 'settings.json'),
      `${JSON.stringify(
        {
          version: 1,
          llm: {
            protocol: 'openai-chat',
            baseUrl: 'https://proxy.example/v1',
            model: 'proxy-model',
            canonicalModel: 'openai/gpt-4o',
            generation: { temperature: 0.2, topP: 0.9, maxOutputTokens: 2048 },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const settings = await loadProjectSettings(directory);
    const config = resolveCliConfiguration(
      {
        SCHEMANAUT_LLM_TEMPERATURE: '0.4',
        SCHEMANAUT_DATABASE_URL: 'postgresql://tester@127.0.0.1/demo',
      },
      settings,
    );

    expect(config).toMatchObject({
      protocol: 'openai-chat',
      baseUrl: 'https://proxy.example/v1',
      model: 'proxy-model',
      canonicalModel: 'openai/gpt-4o',
      generation: { temperature: 0.4, topP: 0.9, maxOutputTokens: 2048 },
    });
  });

  it('rejects configured context windows because model capacity is discovered metadata', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, '.schemanaut'), { recursive: true });
    await writeFile(
      join(directory, '.schemanaut', 'settings.json'),
      `${JSON.stringify({ version: 1, llm: { model: 'm', contextWindow: 32768 } })}\n`,
      'utf8',
    );

    await expect(loadProjectSettings(directory)).rejects.toThrow(/context.*read-only|上下文.*只读/i);
  });

  it('shows useful SQL actions, collapses before the answer, and restores them on Ctrl+O toggle', () => {
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
    const beforeExpand = capture.text().length;
    expect(trace.toggle()).toBe(true);
    expect(capture.text().slice(beforeExpand)).toContain(
      'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
    );
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

  it('shows process commands and useful completion status without dumping process internals', () => {
    const capture = captureOutput(false);
    const trace = new CliTraceRenderer(capture.output);

    trace.render({
      id: 'event-command-1',
      sessionId: 'session-1',
      type: 'command-prepared',
      message: '正在执行项目命令。',
      command: 'pnpm test --filter core-agent',
      toolName: 'process_exec',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    trace.render({
      id: 'event-command-2',
      sessionId: 'session-1',
      type: 'command-executed',
      message: '命令执行完成，退出码 0。',
      command: 'pnpm test --filter core-agent',
      toolName: 'process_exec',
      metrics: { durationMs: 1250, exitCode: 0 },
      createdAt: '2026-08-01T00:00:01.250Z',
    });

    expect(capture.text()).toContain('pnpm test --filter core-agent');
    expect(capture.text()).toContain('退出码 0');
    expect(capture.text()).not.toMatch(/processId|nextCursor|spool|catalogRevision/);
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
