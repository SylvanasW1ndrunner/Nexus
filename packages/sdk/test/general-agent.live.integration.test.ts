import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime } from '../src/index.js';

const runLive = process.env.DBAGENT_RUN_GENERAL_AGENT_LIVE === '1';
const temporaryDirectories: string[] = [];
const reportPath = fileURLToPath(
  new URL('../../../reports/agent-runtime/live-project.json', import.meta.url),
);
let report: Record<string, unknown> | undefined;

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  if (!runLive || !report) return;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});

describe.skipIf(!runLive)('DatabaseAgentRuntime real-model general project scenario', () => {
  it('discovers project tools, patches code, runs a real test process, and delivers evidence', async () => {
    const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
    if (!apiKey) throw new Error('需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY。');
    const model =
      process.env.TEST_SILICONFLOW_MODEL ?? process.env.DBAGENT_LLM_MODEL ?? 'Qwen/Qwen3-32B';
    const projectDirectory = await createBrokenProject();
    const runtime = new DatabaseAgentRuntime({
      projectDirectory,
      sessionDatabasePath: join(projectDirectory, '.state', 'agent.db'),
      provider: new OpenAICompatibleProvider({
        id: 'general-project-live',
        name: 'General project live provider',
        apiKey,
        baseUrl: process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        timeoutMs: 120_000,
        maxRetries: 2,
      }),
      model,
      enableProcessTools: true,
      dynamicToolDiscovery: true,
    });
    const startedAt = performance.now();
    let output: Awaited<ReturnType<DatabaseAgentRuntime['runAgent']>> | undefined;
    let failure: unknown;
    try {
      await runtime.discoverLlmModels();
      output = await runtime.runAgent({
        userId: 'general-project-live-user',
        message:
          '这个项目的 src/calculate.mjs 有测试失败。请定位并实际修复代码，运行项目测试完成验证，最后说明修改内容和测试结果；不要只给建议。',
        mode: 'full',
        maxIterations: 15,
        maxToolExecutionMs: 120_000,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const source = await readFile(join(projectDirectory, 'src', 'calculate.mjs'), 'utf8');
      const tools = output.result.toolExecutions;
      const write = tools.find(
        (tool) =>
          ['workspace_write', 'workspace_edit', 'workspace_patch'].includes(tool.toolName) &&
          tool.status === 'success',
      );
      const process = [...tools]
        .reverse()
        .find(
          (tool) =>
            ['process_exec', 'process_poll'].includes(tool.toolName) &&
            tool.status === 'success' &&
            tool.completionEvidence?.outcome === 'succeeded',
        );

      expect(output.result.status).toBe('done');
      expect(output.result.completion).toMatchObject({
        verified: true,
        deliveryReady: true,
        finalResponseReady: true,
        phase: 'done',
      });
      expect(source).toContain('left + right');
      expect(write, '模型没有通过文件工具完成实际修改').toBeDefined();
      expect(process, '模型没有通过真实进程成功运行测试').toBeDefined();
      expect(output.result.artifacts?.some((artifact) => artifact.path === 'src/calculate.mjs')).toBe(
        true,
      );
      expect(tools.some((tool) => /sql|knowledge/i.test(tool.toolName))).toBe(false);
      expect(output.result.iterations).toBeLessThanOrEqual(15);
      expect(output.result.session.tokenUsage.totalTokens).toBeLessThanOrEqual(180_000);
      expect(durationMs).toBeLessThanOrEqual(300_000);
      expect(isProcessOnlyFinalText(output.result.finalText)).toBe(false);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      report = {
        generatedAt: new Date().toISOString(),
        runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
        provider: 'SiliconFlow OpenAI-compatible',
        model,
        passed: failure === undefined,
        durationMs,
        ...(failure === undefined ? {} : { error: errorMessage(failure) }),
        ...(output === undefined
          ? {}
          : {
              run: {
                runId: output.result.runId,
                sessionId: output.result.session.id,
                status: output.result.status,
                iterations: output.result.iterations,
                tokenUsage: output.result.session.tokenUsage,
                tools: output.result.toolExecutions.map((tool) => ({
                  name: tool.toolName,
                  status: tool.status,
                  durationMs: tool.durationMs,
                  completionEvidence: tool.completionEvidence,
                  resultPreview: bounded(tool.resultPreview, 1_500),
                })),
                artifacts: output.result.artifacts,
                completion: output.result.completion,
                finalText: output.result.finalText,
              },
            }),
      };
      await runtime.close();
    }
  }, 360_000);
});

async function createBrokenProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-general-live-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(
    join(directory, 'AGENTS.md'),
    [
      '# Project instructions',
      'Use the existing Node.js test command as the completion check.',
      'Make the smallest code change that satisfies the test.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'schemanaut-live-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node test.mjs' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(directory, 'src', 'calculate.mjs'),
    'export function add(left, right) {\n  return left - right;\n}\n',
    'utf8',
  );
  await writeFile(
    join(directory, 'test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from './src/calculate.mjs';",
      'assert.equal(add(7, 5), 12);',
      "process.stdout.write('tests passed\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
  return directory;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessOnlyFinalText(text: string): boolean {
  return /(?:let me|i(?:'ll| will)|让我|我来|接下来|下一步|正在).{0,60}(?:verify|check|验证|检查|继续|确认)/i.test(
    text,
  );
}
