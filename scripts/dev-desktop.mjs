import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const appDir = process.cwd();
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

const children = [];

function run(name, args, options = {}) {
  const child = spawn(pnpm, args, {
    cwd: appDir,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...options.env },
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && !shuttingDown) {
      console.error(`${name} exited with ${code}`);
      shutdown(code);
    }
  });
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('main', ['exec', 'vite', 'build', '--mode', 'main', '--watch']);
run('preload', ['exec', 'vite', 'build', '--mode', 'preload', '--watch']);
run('renderer', ['exec', 'vite', '--host', '127.0.0.1']);

const mainEntry = join(appDir, 'dist', 'main', 'main.js');
for (let i = 0; i < 80; i += 1) {
  if (existsSync(mainEntry)) break;
  await delay(250);
}

if (!existsSync(mainEntry)) {
  console.error('Timed out waiting for Electron main build.');
  shutdown(1);
}

await delay(800);
run('electron', ['exec', 'electron', '.'], {
  env: {
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
  },
});
