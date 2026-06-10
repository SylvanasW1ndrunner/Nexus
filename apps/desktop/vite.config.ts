import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const configDir = fileURLToPath(new URL('.', import.meta.url));
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'node-pty',
  'pg',
];

export default defineConfig(({ mode }) => {
  const isMain = mode === 'main';
  const isPreload = mode === 'preload';

  if (isMain || isPreload) {
    return {
      build: {
        outDir: isMain ? 'dist/main' : 'dist/preload',
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve(configDir, isMain ? 'src/main/main.ts' : 'src/preload/preload.ts'),
          formats: ['cjs'],
          fileName: isMain ? 'main' : 'preload',
        },
        rollupOptions: {
          external,
        },
      },
    };
  }

  return {
    base: './',
    plugins: [react()],
    root: 'src/renderer',
    test: {
      root: configDir,
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
    build: {
      outDir: '../../dist/renderer',
      emptyOutDir: false,
      sourcemap: false,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
