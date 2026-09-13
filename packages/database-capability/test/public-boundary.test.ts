import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as databaseCapability from '../src/index.js';

describe('database Capability public boundary', () => {
  it('does not retain in-memory AI SQL results or driver-level execution seams', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/ai-sql-tools.ts', import.meta.url)),
      'utf8',
    );

    expect(databaseCapability).not.toHaveProperty('AiSqlResultStore');
    expect(source).not.toMatch(/\bAiSqlResultStore\b|\bIDatabaseDriver\b|capStoredQueryResult|storedRowCount/u);
  });
});
