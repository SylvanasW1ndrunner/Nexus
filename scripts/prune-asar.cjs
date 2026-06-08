const { rm } = require('node:fs/promises');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

module.exports = async function pruneAsar(context) {
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!existsSync(asarPath)) return;

  const tempDir = path.join(context.appOutDir, 'resources', 'app-pruned');
  await rm(tempDir, { recursive: true, force: true });
  asar.extractAll(asarPath, tempDir);

  const dbagentModules = path.join(tempDir, 'node_modules', '@dbagent');
  if (existsSync(dbagentModules)) {
    for (const packageName of readdirSync(dbagentModules)) {
      const packageDir = path.join(dbagentModules, packageName);
      await rm(path.join(packageDir, 'src'), { recursive: true, force: true });
      await rm(path.join(packageDir, 'test'), { recursive: true, force: true });
      await rm(path.join(packageDir, '.turbo'), { recursive: true, force: true });
      await rm(path.join(packageDir, 'tsconfig.json'), { force: true });
      await rm(path.join(packageDir, 'tsconfig.tsbuildinfo'), { force: true });
      await pruneDist(path.join(packageDir, 'dist'));
    }
  }

  await rm(asarPath, { force: true });
  await asar.createPackageWithOptions(tempDir, asarPath, {});
  await rm(tempDir, { recursive: true, force: true });
};

async function pruneDist(distDir) {
  if (!existsSync(distDir)) return;
  for (const entry of readdirSync(distDir)) {
    if (
      entry.endsWith('.map') ||
      entry.endsWith('.test.js') ||
      entry.endsWith('.test.d.ts')
    ) {
      await rm(path.join(distDir, entry), { force: true });
    }
  }
}
