import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const skipLaunch = process.argv.includes('--skip-launch');
const appOutDir = packageOutputDir();
const resourcesDir = join(appOutDir, 'resources');
const asarPath = join(resourcesDir, 'app.asar');
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const asar = desktopRequire('@electron/asar');

assert.ok(existsSync(appOutDir), `missing packaged app directory: ${appOutDir}`);
assert.ok(existsSync(asarPath), `missing ASAR package: ${asarPath}`);
const asarStats = statSync(asarPath);

const files = asar.listPackage(asarPath).map((file) => file.replaceAll('\\', '/'));
const requiredFiles = [
  '/dist/main/main.cjs',
  '/dist/preload/preload.cjs',
  '/dist/renderer/index.html',
  '/package.json',
];

for (const file of requiredFiles) {
  assert.ok(files.includes(file), `ASAR missing required file: ${file}`);
}

const suspicious = files.filter((file) =>
  /\/node_modules\/@dbagent\/.*(\/src\/|\/test\/|\/\.turbo|tsconfig\.tsbuildinfo|\.ts$|\.map$)/.test(file),
);
assert.deepEqual(suspicious, [], `ASAR contains development files:\n${suspicious.slice(0, 20).join('\n')}`);

const executablePath = packagedExecutablePath(appOutDir);
assert.ok(existsSync(executablePath), `missing packaged executable: ${executablePath}`);
assert.ok(statSync(executablePath).size > 0, `packaged executable is empty: ${executablePath}`);

const latestInput = latestPackageInputMtime();
assert.ok(
  asarStats.mtimeMs + 2000 >= latestInput.mtimeMs,
  `ASAR is older than package input: ${latestInput.path}. Run pnpm package:dir before verification.`,
);

if (!skipLaunch) {
  await verifyLaunch(executablePath);
}

console.log('Packaged app verification passed.');
console.log(`- appOutDir: ${appOutDir}`);
console.log(`- asarFiles: ${files.length}`);
console.log(`- executable: ${executablePath}`);
console.log(`- latestPackageInput: ${latestInput.path}`);

function packageOutputDir() {
  if (process.platform === 'win32') return join(root, 'apps', 'desktop', 'release', 'win-unpacked');
  if (process.platform === 'darwin') return join(root, 'apps', 'desktop', 'release', 'mac', 'DBAgent.app');
  return join(root, 'apps', 'desktop', 'release', 'linux-unpacked');
}

function packagedExecutablePath(outputDir) {
  if (process.platform === 'win32') return join(outputDir, 'DBAgent.exe');
  if (process.platform === 'darwin') return join(outputDir, 'Contents', 'MacOS', 'DBAgent');
  return join(outputDir, 'DBAgent');
}

function latestPackageInputMtime() {
  const candidates = [
    join(root, 'apps', 'desktop', 'dist'),
    join(root, 'apps', 'desktop', 'package.json'),
    join(root, 'packages', 'shared', 'dist'),
    join(root, 'packages', 'core-db', 'dist'),
    join(root, 'packages', 'core-auth', 'dist'),
    join(root, 'packages', 'core-usage', 'dist'),
    join(root, 'packages', 'core-llm', 'dist'),
  ];
  return candidates.reduce(
    (latest, candidate) => {
      const current = latestMtime(candidate);
      return current.mtimeMs > latest.mtimeMs ? current : latest;
    },
    { path: '', mtimeMs: 0 },
  );
}

function latestMtime(path) {
  assert.ok(existsSync(path), `missing package input: ${path}`);
  const stats = statSync(path);
  if (!stats.isDirectory()) return { path, mtimeMs: stats.mtimeMs };

  let latest = { path, mtimeMs: stats.mtimeMs };
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const current = entry.isDirectory() ? latestMtime(child) : { path: child, mtimeMs: statSync(child).mtimeMs };
    if (current.mtimeMs > latest.mtimeMs) latest = current;
  }
  return latest;
}

async function verifyLaunch(executablePath) {
  const child = spawn(executablePath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  let exitedEarly = false;
  child.once('exit', (code, signal) => {
    exitedEarly = true;
    child.exitSummary = { code, signal };
  });

  await delay(6000);

  if (exitedEarly) {
    const summary = child.exitSummary;
    throw new Error(`Packaged app exited before verification window: code=${summary.code} signal=${summary.signal}`);
  }

  child.kill();
  await delay(500);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
