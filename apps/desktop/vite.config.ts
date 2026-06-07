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
        sourcemap: true,
        lib: {
          entry: resolve(configDir, isMain ? 'src/main/main.ts' : 'src/preload/preload.ts'),
          formats: ['es'],
          fileName: isMain ? 'main' : 'preload',
        },
        rollupOptions: {
          external,
        },
      },
    };
  }

  return {
    plugins: [react()],
    root: 'src/renderer',
    build: {
      outDir: '../../dist/renderer',
      emptyOutDir: false,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
