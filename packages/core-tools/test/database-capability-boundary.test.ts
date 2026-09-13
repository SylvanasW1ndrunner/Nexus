import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('core-tools database Capability boundary', () => {
  it('does not ship database or Schema-RAG implementations', async () => {
    const [manifest, index] = await Promise.all([
      readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8'),
    ]);

    expect(manifest).not.toMatch(/@dbagent\/(?:core-db|core-rag)/u);
    expect(index).not.toMatch(/ai-sql-tools|agent-knowledge-projection/u);
  });
});
