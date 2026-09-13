#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-unified-agent-live-test.mjs', import.meta.url));
const child = spawn(process.execPath, [runner], {
  env: { ...process.env, DBAGENT_LIVE_ACCEPTANCE_SCOPE: 'database-long-result' },
  stdio: 'inherit',
  windowsHide: true,
});

await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => signal ? reject(new Error(`Unified live runner stopped by ${signal}.`)) : resolve(code ?? 1));
}).then((code) => { if (code !== 0) process.exitCode = code; });
