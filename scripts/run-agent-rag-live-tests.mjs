import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultReportDir = join(root, 'tmp', 'agent-rag-live-report');
const reportDir = process.env.DBAGENT_AGENT_RAG_REPORT_DIR ?? defaultReportDir;
const localVitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const hasLocalVitest = existsSync(localVitest);
const command = hasLocalVitest
  ? process.execPath
  : process.platform === 'win32'
    ? 'pnpm.cmd'
    : 'pnpm';
const args = hasLocalVitest
  ? [localVitest, 'run', 'packages/core-tools/test/agent-rag-business-scenario.test.ts']
  : ['exec', 'vitest', 'run', 'packages/core-tools/test/agent-rag-business-scenario.test.ts'];

const hasApiKey = Boolean(process.env.TEST_SILICONFLOW_API_KEY || process.env.DBAGENT_LLM_API_KEY);
if (!hasApiKey) {
  console.error(
    [
      'SiliconFlow live Agent/RAG tests require TEST_SILICONFLOW_API_KEY or DBAGENT_LLM_API_KEY.',
      'Set the key in your shell environment; do not commit it to files.',
      'Example: $env:TEST_SILICONFLOW_API_KEY=<本机临时密钥>',
    ].join('\n'),
  );
  process.exit(1);
}

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    DBAGENT_RUN_AGENT_RAG_LIVE: '1',
    DBAGENT_AGENT_RAG_REPORT_DIR: reportDir,
    TEST_SILICONFLOW_MODEL: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
  },
  shell: !hasLocalVitest && process.platform === 'win32',
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code === 0) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'run.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          command,
          args,
          model: process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro',
          reportDir,
          status: 'passed',
        },
        null,
        2,
      ),
    );
    console.log(`Agent/RAG live test report written to ${reportDir}`);
  }
  process.exit(code ?? 1);
});
