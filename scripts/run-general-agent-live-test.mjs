import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await loadEnvFile(join(root, '.env'));

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'test/general-agent.live.integration.test.ts',
      '--pool=threads',
    ],
    {
      cwd: join(root, 'packages', 'sdk'),
      env: {
        ...process.env,
        DBAGENT_RUN_GENERAL_AGENT_LIVE: '1',
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) {
      reject(new Error(`General Agent live test stopped by ${signal}.`));
      return;
    }
    if (code === 0) resolve();
    else reject(new Error(`General Agent live test failed with exit code ${code ?? 1}.`));
  });
});
