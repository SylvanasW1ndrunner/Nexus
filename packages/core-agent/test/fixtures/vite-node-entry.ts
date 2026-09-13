import { createRequire } from 'node:module';

/**
 * Resolves vite-node as its own package.  Vitest and vite-node may reside in
 * different pnpm virtual-store directories, so deriving one from the other is
 * not a valid executable path.
 */
export function resolveViteNodeEntry(): string {
  return createRequire(import.meta.url).resolve('vite-node/vite-node.mjs');
}
