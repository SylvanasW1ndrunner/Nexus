import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystemPromises from 'node:fs/promises';

const injected = vi.hoisted(() => ({ code: '', pathFragment: '' }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FileSystemPromises>('node:fs/promises');
  return {
    ...actual,
    open: async (...input: Parameters<typeof actual.open>) => {
      const path = String(input[0]).replaceAll('\\', '/');
      if (injected.code && path.includes(injected.pathFragment)) {
        const error = new Error(`injected ${injected.code}`) as NodeJS.ErrnoException;
        error.code = injected.code;
        throw error;
      }
      return await actual.open(...input);
    },
  };
});

import { ProjectDatabaseResultStore } from '../src/project-result-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  injected.code = '';
  injected.pathFragment = '';
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('ProjectDatabaseResultStore portable filesystem failures', () => {
  it.each([
    ['ENOSPC', 'disk-full'],
    ['EACCES', 'permission-denied'],
    ['EROFS', 'read-only'],
  ])('normalizes %s during real chunk persistence as STORAGE_FAILURE', async (code, label) => {
    const directory = await mkdtemp(join(tmpdir(), `schemanaut-result-${label}-`));
    temporaryDirectories.push(directory);
    const store = new ProjectDatabaseResultStore({
      projectId: `project-${label}`,
      rootDir: join(directory, 'results'),
    });
    const writer = await store.create({
      resultId: `result_${label.replaceAll('-', '_')}`,
      jobId: `job-${label}`,
      columns: [{ name: 'value' }],
    });
    injected.code = code;
    injected.pathFragment = '/staging/chunk-';

    await expect(writer.append([{ value: label }], { operationId: 'batch-0' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });

  it.each([
    ['ENOSPC', 'disk-full'],
    ['EACCES', 'permission-denied'],
    ['EROFS', 'read-only'],
  ])('normalizes %s while opening an export target without corrupting its source', async (code, label) => {
    const directory = await mkdtemp(join(tmpdir(), `schemanaut-export-${label}-`));
    temporaryDirectories.push(directory);
    const store = new ProjectDatabaseResultStore({
      projectId: `project-export-${label}`,
      rootDir: join(directory, 'results'),
    });
    const writer = await store.create({
      resultId: `result_export_${label.replaceAll('-', '_')}`,
      jobId: `job-export-${label}`,
      columns: [{ name: 'value' }],
    });
    await writer.append([{ value: label }], { operationId: 'batch-0' });
    const handle = await writer.commit();
    injected.code = code;
    injected.pathFragment = '/staging/export-';

    await expect(store.export(handle, 'jsonl')).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    await expect(store.inspect(handle.id)).resolves.toMatchObject({
      availability: 'available',
    });
    await expect(store.page(handle, { limit: 1 })).resolves.toMatchObject({
      rows: [{ value: label }],
    });
  });
});
