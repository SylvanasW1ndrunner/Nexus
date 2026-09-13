import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeError } from '@dbagent/agent-host';
import {
  classifyCliApprovalInput,
  classifyCliOutcomeInput,
  CliTraceRenderer,
  formatCliError,
  formatCliRunOutcome,
  initializeCliProject,
  listCliSessions,
  listCliSkills,
  startInteractiveCli,
  submitCliOutcomeDecision,
} from '../src/interactive-cli.js';
import { resumeCliRun } from '../src/cli-run-resume.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 20,
    })),
  );
});

describe('SchemaNaut CLI', () => {
  it('reopens and resumes an existing Run without starting another Run', async () => {
    const calls: string[] = [];
    const handle = {
      runId: 'run-interrupted-1',
      sessionId: 'session-1',
      resume: () => {
        calls.push('resume');
        return Promise.resolve();
      },
    };
    const runtime = {
      openAgentRun: (runId: string) => {
        calls.push(`open:${runId}`);
        return Promise.resolve(handle);
      },
      startAgentRun: () => {
        calls.push('start');
        return Promise.reject(new Error('must not create a Run'));
      },
    };

    await expect(resumeCliRun(runtime, handle.runId)).resolves.toBe(handle);

    expect(calls).toEqual(['open:run-interrupted-1', 'resume']);
  });

  it('renders typed tool activity, collapses before the answer, and restores it on Ctrl+O toggle', () => {
    const capture = captureOutput(true);
    const trace = new CliTraceRenderer(capture.output);

    trace.start();
    trace.render({
      schemaVersion: 1,
      sourceSequence: 4,
      activityId: 'activity-4',
      runId: 'run-1',
      kind: 'tool',
      phase: 'started',
      summary: '正在准备执行已验证的查询。',
      detail: { actionSummary: '正在准备执行已验证的查询。' },
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    expect(capture.text()).toContain('正在准备执行已验证的查询');

    trace.clearBeforeFinal();
    expect(capture.text()).toContain('\u001B[1A');
    expect(capture.text()).toContain('\u001B[2K');
    const beforeExpand = capture.text().length;
    expect(trace.toggle()).toBe(true);
    expect(capture.text().slice(beforeExpand)).toContain('正在准备执行已验证的查询');
  });

  it('supports disabling action traces and keeps non-TTY logs durable', () => {
    const silentCapture = captureOutput(false);
    const silent = new CliTraceRenderer(silentCapture.output);
    silent.setEnabled(false);
    silent.start();
    silent.render({
      schemaVersion: 1,
      sourceSequence: 2,
      activityId: 'activity-2',
      runId: 'run-1',
      kind: 'status',
      phase: 'progress',
      summary: '正在读取 Schema。',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    expect(silentCapture.text()).toBe('');

    const loggedCapture = captureOutput(false);
    const logged = new CliTraceRenderer(loggedCapture.output);
    logged.start();
    logged.render({
      schemaVersion: 1,
      sourceSequence: 2,
      activityId: 'activity-2',
      runId: 'run-1',
      kind: 'status',
      phase: 'progress',
      summary: '正在读取 Schema。',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    const beforeClear = loggedCapture.text();
    logged.clearBeforeFinal();
    expect(loggedCapture.text()).toBe(beforeClear);
    expect(beforeClear).toContain('正在读取 Schema');
  });

  it('replaces tentative preview history by replaceKey instead of replaying discarded text', () => {
    const capture = captureOutput(true);
    const trace = new CliTraceRenderer(capture.output);
    trace.start();
    trace.render({
      schemaVersion: 1,
      sourceSequence: 2,
      activityId: 'activity-preview',
      runId: 'run-1',
      kind: 'model-preview',
      phase: 'progress',
      summary: 'Tentative fragment that must be withdrawn.',
      replaceKey: 'attempt-1',
      createdAt: '2026-07-31T00:00:00.000Z',
    });
    trace.render({
      schemaVersion: 1,
      sourceSequence: 3,
      activityId: 'activity-discarded',
      runId: 'run-1',
      kind: 'model-preview',
      phase: 'discarded',
      summary: 'Tentative model output was discarded.',
      replaceKey: 'attempt-1',
      createdAt: '2026-07-31T00:00:01.000Z',
    });
    trace.clearBeforeFinal();
    const beforeReplay = capture.text().length;

    expect(trace.toggle()).toBe(true);
    const replay = capture.text().slice(beforeReplay);
    expect(replay).toContain('Tentative model output was discarded.');
    expect(replay).not.toContain('Tentative fragment that must be withdrawn.');
  });

  it('shows process commands and useful completion status without dumping process internals', () => {
    const capture = captureOutput(false);
    const trace = new CliTraceRenderer(capture.output);

    trace.render({
      schemaVersion: 1,
      sourceSequence: 5,
      activityId: 'activity-5',
      runId: 'run-1',
      kind: 'tool',
      phase: 'started',
      summary: 'Run the project test command.',
      detail: {
        actionSummary: 'Run the project test command.',
        rawArguments: { command: 'must-not-render' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    trace.render({
      schemaVersion: 1,
      sourceSequence: 7,
      activityId: 'activity-7',
      runId: 'run-1',
      kind: 'result',
      phase: 'succeeded',
      summary: '命令执行完成，退出码 0。',
      createdAt: '2026-08-01T00:00:01.250Z',
    });

    expect(capture.text()).toContain('Run the project test command.');
    expect(capture.text().split('Run the project test command.')).toHaveLength(2);
    expect(capture.text()).toContain('退出码 0');
    expect(capture.text()).not.toMatch(/processId|nextCursor|spool|catalogRevision|must-not-render/);
  });

  it('does not expose Runtime evidence or raw rows in result activity', () => {
    const capture = captureOutput(false);
    const trace = new CliTraceRenderer(capture.output);

    trace.render({
      schemaVersion: 1,
      sourceSequence: 8,
      activityId: 'activity-result-8',
      runId: 'run-1',
      kind: 'result',
      phase: 'succeeded',
      summary: '查询结果已保存。',
      evidenceRefs: [
        'schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
      detail: { rows: [{ secret: 'must-not-render' }] },
      createdAt: '2026-08-01T00:00:02.000Z',
    });

    expect(capture.text()).not.toContain('schemanaut-evidence:');
    expect(capture.text()).not.toContain('must-not-render');
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

  it('accepts only explicit success or failure when resolving an unknown outcome', () => {
    expect(['s', 'success', 'succeeded', '成功'].map(classifyCliOutcomeInput)).toEqual([
      'succeeded', 'succeeded', 'succeeded', 'succeeded',
    ]);
    expect(['f', 'fail', 'failed', '失败'].map(classifyCliOutcomeInput)).toEqual([
      'failed', 'failed', 'failed', 'failed',
    ]);
    expect(['r', 'retry', '重试'].map(classifyCliOutcomeInput)).toEqual([
      'retry', 'retry', 'retry',
    ]);
    expect(classifyCliOutcomeInput('continue')).toBe('invalid');
  });

  it('shows typed outcome conflict codes instead of reducing them to generic messages', () => {
    const conflict = new AgentRuntimeError(
      'OUTCOME_RESOLUTION_CONFLICT',
      '该外部操作结果已经确认，不能改为相反结果。',
    );

    expect(formatCliError(conflict)).toBe(
      '[OUTCOME_RESOLUTION_CONFLICT] 该外部操作结果已经确认，不能改为相反结果。',
    );
    expect(formatCliError(new AgentRuntimeError(
      'RISKY_RETRY_AUTHORIZATION_CONFLICT',
      '该风险重试请求与已持久化的授权不一致。',
    ))).toBe(
      '[RISKY_RETRY_AUTHORIZATION_CONFLICT] 该风险重试请求与已持久化的授权不一致。',
    );
  });

  it('presents terminal Run failures and interruptions instead of an empty answer', () => {
    expect(formatCliRunOutcome({
      runId: 'run-failed',
      sessionId: 'session-1',
      status: 'failed',
      finalText: '',
      evidenceRevision: 0,
      evidenceRefs: [],
      error: {
        code: 'MODEL_PROTOCOL_FAILED',
        detail: { category: 'model-gateway', code: 'MODEL_PROTOCOL_FAILED', retryable: false },
      },
    })).toEqual({
      tone: 'red',
      heading: '运行失败',
      body: '[MODEL_PROTOCOL_FAILED]',
    });

    expect(formatCliRunOutcome({
      runId: 'run-interrupted',
      sessionId: 'session-1',
      status: 'interrupted',
      finalText: '',
      evidenceRevision: 0,
      evidenceRefs: [],
      error: {
        code: 'MODEL_GATEWAY_FAILED',
        detail: { category: 'model-gateway', code: 'MODEL_TRANSPORT_FAILED', statusCode: 503 },
      },
    })).toEqual({
      tone: 'yellow',
      heading: '运行已中断',
      body: '[MODEL_GATEWAY_FAILED] 原因 MODEL_TRANSPORT_FAILED（HTTP 503）\n可使用 /run resume run-interrupted 继续。',
    });
  });

  it('keeps Runtime evidence internal in the completed Run outcome', () => {
    expect(formatCliRunOutcome({
      runId: 'run-completed',
      sessionId: 'session-1',
      status: 'completed',
      finalText: '查询已完成。',
      evidenceRevision: 3,
      evidenceRefs: [
        'schemanaut-evidence:v1:artifact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
    })).toEqual({
      tone: 'green',
      heading: '回答',
      body: '查询已完成。',
    });
  });

  it('uses risky-retry authorization as one atomic third outcome decision', async () => {
    const calls: Array<{ type: string; input: Record<string, unknown> }> = [];
    const handle = {
      authorizeRiskyRetry(input: Record<string, unknown>): Promise<void> {
        calls.push({ type: 'authorize', input });
        return Promise.resolve();
      },
      resolveOutcome(input: Record<string, unknown>): Promise<void> {
        calls.push({ type: 'resolve', input });
        return Promise.resolve();
      },
    };

    await submitCliOutcomeDecision(handle, {
      invocationId: 'invocation-unknown-1',
      decision: 'retry',
      riskyRetryClientRequestId: 'cli-risky-retry-1',
    });

    expect(calls).toEqual([
      {
        type: 'authorize',
        input: {
          invocationId: 'invocation-unknown-1',
          reason: '用户已明确承担非幂等操作可能重复执行的风险。',
          clientRequestId: 'cli-risky-retry-1',
        },
      },
    ]);
  });

  it('creates a generic project without credentials or database-specific directories', async () => {
    const directory = join(await temporaryDirectory(), 'new-project');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await initializeCliProject(directory);

    expect((await stat(join(directory, '.schemanaut', 'skills'))).isDirectory()).toBe(true);
    expect((await stat(join(directory, 'artifacts'))).isDirectory()).toBe(true);
    await expect(stat(join(directory, 'sql'))).rejects.toMatchObject({ code: 'ENOENT' });
    const settings = await readFile(join(directory, '.schemanaut', 'settings.json'), 'utf8');
    expect(settings).toBe(
      `${JSON.stringify({
        version: 1,
        mcp: { servers: {} },
      }, null, 2)}\n`,
    );
    await expect(stat(join(directory, '.schemanaut', 'mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(settings).not.toMatch(/api.?key|password|token|secret/i);
  });

  it('lists a project Skill override without exposing an unavailable system Skill', async () => {
    const directory = await temporaryDirectory();
    await initializeCliProject(directory);
    const skillDirectory = join(directory, '.schemanaut', 'skills', 'query-and-answer');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: query-and-answer',
        'description: Project-specific query guidance.',
        '---',
        '',
        'Always filter deleted_at IS NULL.',
      ].join('\n'),
      'utf8',
    );

    const skills = await listCliSkills({ projectDirectory: directory });

    expect(skills).toContainEqual({
      name: 'query-and-answer',
      description: 'Project-specific query guidance.',
      scope: 'project',
    });
    expect(skills).not.toContainEqual(
      expect.objectContaining({
        name: 'query-and-answer',
        scope: 'system',
      }),
    );
  });

  it('uses one Project-local state database without requiring environment configuration', async () => {
    const directory = await temporaryDirectory();
    await initializeCliProject(directory);

    await expect(
      listCliSessions({ projectDirectory: directory }),
    ).resolves.toEqual([]);
    expect((await stat(join(directory, '.schemanaut', 'state.db'))).isFile()).toBe(true);
  });

  it('opens an empty project with actionable settings guidance instead of crashing', async () => {
    const projectDirectory = await temporaryDirectory();
    const input = new PassThrough();
    const capture = captureOutput(false);
    const operation = startInteractiveCli({
      projectDirectory,
      input,
      output: capture.output,
    });
    await vi.waitFor(() => expect(capture.text()).toContain('config.toml'));
    input.end('/exit\n');
    await operation;
    expect(capture.text()).toContain('尚未选择模型');
    expect(capture.text()).toContain('/models');
    expect(capture.text()).not.toContain('/connect');
    expect(capture.text()).not.toMatch(/SCHEMANAUT_LLM_|SCHEMANAUT_DATABASE_URL/);
  });

  it('keeps the CLI available to repair and revalidate an invalid settings file', async () => {
    const projectDirectory = await temporaryDirectory();
    const configDirectory = join(projectDirectory, '.schemanaut');
    const settingsPath = join(configDirectory, 'settings.json');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(settingsPath, '{"version":1,"llm":{"model":"invalid"},"modules":{}}', 'utf8');

    const input = new PassThrough();
    const capture = captureOutput(false);
    const operation = startInteractiveCli({ projectDirectory, input, output: capture.output });
    await vi.waitFor(() => expect(capture.text()).toContain('schemanaut> '));
    input.write('/settings validate\n');
    await vi.waitFor(() => expect(capture.text()).toContain('Model configuration moved'));
    expect(capture.text()).toContain(settingsPath);

    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 1,
        mcp: { servers: {} },
      }, null, 2)}\n`,
      'utf8',
    );
    input.write('/settings validate\n');
    await vi.waitFor(() => expect(capture.text()).toContain('settings.json 校验通过'));
    input.end('/exit\n');
    await operation;
  });

  it('advertises only read-only settings commands and runtime model selection', async () => {
    const input = new PassThrough();
    const capture = captureOutput(false);
    const operation = startInteractiveCli({
      projectDirectory: await temporaryDirectory(),
      input,
      output: capture.output,
    });
    await vi.waitFor(() => expect(capture.text()).toContain('schemanaut> '));
    input.write('/help\n');
    await vi.waitFor(() => expect(capture.text()).toContain('/settings validate'));
    input.end('/exit\n');
    await operation;

    expect(capture.text()).toContain('/model [list|current|序号|模型名]');
    expect(capture.text()).toContain('/config [show|path|validate]');
    expect(capture.text()).toContain('全局配置');
    expect(capture.text()).not.toContain('/mode ');
    expect(capture.text()).toContain('/run resume <run-id>');
    expect(capture.text()).toContain('/skills [list|reload|info]');
    expect(capture.text()).toContain('/mcp [list|start|stop|doctor]');
    expect(capture.text()).not.toContain('/connect');
    expect(capture.text()).not.toContain('/config session');
    expect(capture.text()).not.toContain('/config project');
    expect(capture.text()).not.toMatch(/capability/i);
  });

  it('operates Skills and MCP from Project files without exposing configuration mutations', async () => {
    const projectDirectory = await temporaryDirectory();
    await initializeCliProject(projectDirectory);
    const skillDirectory = join(projectDirectory, '.schemanaut', 'skills', 'project-guide');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: project-guide',
        'description: Project-specific operating guide.',
        '---',
        '',
        'Use the project conventions.',
      ].join('\n'),
      'utf8',
    );
    const settingsPath = join(projectDirectory, '.schemanaut', 'settings.json');
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 1,
        mcp: {
          servers: {
            docs: {
              transport: 'streamable-http',
              url: 'https://mcp.example.test/service',
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );
    const before = await readFile(settingsPath, 'utf8');

    const input = new PassThrough();
    const capture = captureOutput(false);
    const operation = startInteractiveCli({ projectDirectory, input, output: capture.output });
    await vi.waitFor(() => expect(capture.text()).toContain('schemanaut> '));
    input.write('/skills list\n');
    await vi.waitFor(() => expect(capture.text()).toContain('/project:project-guide'));
    input.write('/skills info project:project-guide\n');
    await vi.waitFor(() => expect(capture.text()).toContain('Project-specific operating guide'));
    input.write('/skills reload\n');
    await vi.waitFor(() => expect(capture.text()).toContain('Skills 已重新加载'));
    input.write('/mcp list\n');
    await vi.waitFor(() => expect(capture.text()).toContain('docs'));
    input.write('/mcp doctor\n');
    await vi.waitFor(() => expect(capture.text()).toContain('MCP 配置: 1 个'));
    input.end('/exit\n');
    await operation;

    expect(await readFile(settingsPath, 'utf8')).toBe(before);
    expect(capture.text()).not.toMatch(
      /\/connect|\/config\s+(?:session|project)\b|capability/i,
    );
  }, 15_000);

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
