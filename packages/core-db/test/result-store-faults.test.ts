import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbColumnValue } from '@dbagent/shared';
import {
  ProjectDatabaseResultStore,
  type ProjectDatabaseResultStoreFailurePoint,
} from '../src/project-result-store.js';

const temporaryDirectories: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('ProjectDatabaseResultStore fault and retention boundaries', { timeout: 30_000 }, () => {
  it('detects checksum corruption before returning any row and persists corrupt availability', async () => {
    const fixture = await createFixture('checksum');
    const handle = await createResult(fixture.store, 'corrupt', [{ value: 'original' }]);
    const objectPath = await firstChunkObject(fixture.rootDir);
    await writeFile(objectPath, '{"value":"tampered"}\n');

    await expect(fixture.store.page(handle, { limit: 100 })).rejects.toMatchObject({
      code: 'CORRUPT', availability: 'corrupt', canReexecute: true,
    });
    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId, rootDir: fixture.rootDir,
    });
    await expect(reopened.inspect(handle.id)).resolves.toMatchObject({
      availability: 'corrupt', canReexecute: true,
    });
    await expect(reopened.page(handle.id, { limit: 1 })).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });

  it('cleans an orphan object when a process dies after promotion but before chunk metadata', async () => {
    const fixture = await createFixture('orphan-object', {
      failureAt: 'after-chunk-object-before-metadata',
    });
    const writer = await fixture.store.create({
      resultId: 'result_orphan_object', jobId: 'job-orphan-object',
      columns: [{ name: 'value' }],
    });
    await expect(writer.append([{ value: 'orphan' }])).rejects.toMatchObject({
      code: 'INJECTED_CRASH',
    });
    expect((await objectFiles(fixture.rootDir)).length).toBe(1);

    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId, rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T14:00:00.000Z'),
    });
    await expect(reopened.collectGarbage({ stagedTtlMs: 60 * 60 * 1_000 }))
      .resolves.toMatchObject({ stagedResultsDeleted: 1, orphanObjectsDeleted: 1 });
    expect(await objectFiles(fixture.rootDir)).toEqual([]);
  });

  it('does not race an active writer during the object-to-metadata commit window', async () => {
    const fixture = await createFixture('active-object-window', {
      failureAt: 'after-chunk-object-before-metadata',
    });
    const writer = await fixture.store.create({
      resultId: 'result_active_object', jobId: 'job-active-object',
      columns: [{ name: 'value' }],
    });
    await expect(writer.append([{ value: 'still-active' }])).rejects.toMatchObject({
      code: 'INJECTED_CRASH',
    });

    const concurrentGc = new ProjectDatabaseResultStore({
      projectId: fixture.projectId, rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T12:00:01.000Z'),
    });
    await expect(concurrentGc.collectGarbage({ stagedTtlMs: 60 * 60 * 1_000 }))
      .resolves.toMatchObject({ stagedResultsDeleted: 0, orphanObjectsDeleted: 0 });
    expect(await objectFiles(fixture.rootDir)).toHaveLength(1);
  });

  it('serializes GC against a second store promoting an object before metadata commit', async () => {
    const fixture = await createFixture('cross-instance-object-window');
    const blocker = await fixture.store.create({
      resultId: 'result_cross_instance_blocker',
      jobId: 'job-cross-instance-blocker',
      columns: [{ name: 'value' }],
    });
    const writerStore = new ProjectDatabaseResultStore({
      projectId: fixture.projectId,
      rootDir: fixture.rootDir,
      failureAt: 'after-chunk-object-before-metadata',
    });
    const writer = await writerStore.create({
      resultId: 'result_cross_instance_writer',
      jobId: 'job-cross-instance-writer',
      columns: [{ name: 'value' }],
    });

    await expect(writer.append([{ value: 'promoted' }])).rejects.toMatchObject({
      code: 'INJECTED_CRASH',
    });
    await expect(fixture.store.collectGarbage({ stagedTtlMs: 0 })).resolves.toMatchObject({
      orphanObjectsDeleted: 0,
    });
    expect(await objectFiles(fixture.rootDir)).toHaveLength(1);
    await blocker.abort();
  });

  it('keeps staged chunk metadata unreadable and removes it after a pre-commit crash', async () => {
    const fixture = await createFixture('staged-metadata', {
      failureAt: 'after-chunk-metadata-before-result-commit',
    });
    const writer = await fixture.store.create({
      resultId: 'result_staged_metadata', jobId: 'job-staged-metadata',
      columns: [{ name: 'value' }],
    });
    await writer.append([{ value: 1 }, { value: 2 }]);
    await expect(writer.commit()).rejects.toMatchObject({ code: 'INJECTED_CRASH' });

    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId, rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T14:00:00.000Z'),
    });
    await expect(reopened.page('result_staged_metadata', { limit: 10 }))
      .rejects.toMatchObject({ code: 'NOT_COMMITTED' });
    await reopened.collectGarbage({ stagedTtlMs: 60 * 60 * 1_000 });
    await expect(reopened.page('result_staged_metadata', { limit: 10 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recovers an available handle when commit succeeded but its response was lost', async () => {
    const fixture = await createFixture('response-loss', {
      failureAt: 'after-result-commit-before-response',
    });
    const writer = await fixture.store.create({
      resultId: 'result_response_loss', jobId: 'job-response-loss',
      columns: [{ name: 'value' }],
    });
    await writer.append([{ value: 'committed' }]);
    await expect(writer.commit()).rejects.toMatchObject({ code: 'INJECTED_CRASH' });

    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId, rootDir: fixture.rootDir,
    });
    const recovered = await reopened.getHandle('result_response_loss');
    expect(recovered).toMatchObject({ availability: 'available', rowCount: 1 });
    await expect(reopened.page(recovered, { limit: 10 })).resolves.toMatchObject({
      rows: [{ value: 'committed' }], complete: true,
    });

    const replay = await reopened.create({
      resultId: 'result_response_loss', jobId: 'job-response-loss',
      columns: [{ name: 'value' }],
    });
    await expect(replay.commit()).resolves.toEqual(recovered);
    await expect(replay.append([{ value: 'duplicate' }])).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('replays an append operation after metadata commit response loss without duplicating rows', async () => {
    const fixture = await createFixture('append-response-loss', {
      failureAt: 'after-append-metadata-before-response',
    });
    const writer = await fixture.store.create({
      resultId: 'result_append_response_loss',
      jobId: 'job-append-response-loss',
      columns: [{ name: 'value' }],
    });
    const rows = [{ value: 'first' }, { value: 'second' }];

    await expect(writer.append(rows, { operationId: 'driver-result-batch-0' }))
      .rejects.toMatchObject({ code: 'INJECTED_CRASH' });
    await expect(writer.append(rows, { operationId: 'driver-result-batch-0' }))
      .resolves.toBeUndefined();
    const handle = await writer.commit();

    expect(handle.rowCount).toBe(2);
    await expect(fixture.store.page(handle, { limit: 10 })).resolves.toMatchObject({
      rows,
      complete: true,
    });
    await expect(writer.append([{ value: 'different' }], {
      operationId: 'driver-result-batch-0',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('replays the same append operation from a new store and writer after a process boundary', async () => {
    const fixture = await createFixture('append-cross-process-loss', {
      failureAt: 'after-append-metadata-before-response',
    });
    const input = {
      resultId: 'result_append_cross_process_loss',
      jobId: 'job-append-cross-process-loss',
      columns: [{ name: 'value' }],
    };
    const firstWriter = await fixture.store.create(input);
    const rows = [{ value: 'one' }, { value: 'two' }];
    await expect(firstWriter.append(rows, { operationId: 'stable-batch' }))
      .rejects.toMatchObject({ code: 'INJECTED_CRASH' });

    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId,
      rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T14:00:00.000Z'),
    });
    const replay = await reopened.create(input);
    await expect(replay.append(rows, { operationId: 'stable-batch' })).resolves.toBeUndefined();
    const handle = await replay.commit();
    await expect(reopened.page(handle, { limit: 10 })).resolves.toMatchObject({ rows });
  });

  it('serializes independent writers with SQLite CAS and never collects an active writer', async () => {
    const fixture = await createFixture('writer-cas');
    const secondStore = new ProjectDatabaseResultStore({
      projectId: fixture.projectId,
      rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });
    const input = {
      resultId: 'result_writer_cas',
      jobId: 'job-writer-cas',
      columns: [{ name: 'value' }],
    };
    const firstWriter = await fixture.store.create(input);
    await expect(secondStore.create(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await firstWriter.append([{ value: 1 }]);
    await expect(fixture.store.collectGarbage({ stagedTtlMs: 60 * 60 * 1_000 }))
      .resolves.toMatchObject({ stagedResultsDeleted: 0 });

    const firstHandle = await firstWriter.commit();
    const replayedWriter = await secondStore.create(input);
    const replayedHandle = await replayedWriter.commit();
    expect(replayedHandle).toEqual(firstHandle);
    await expect(secondStore.page(firstHandle, { limit: 1 })).resolves.toMatchObject({
      rows: [{ value: 1 }],
      complete: true,
    });
    await expect(secondStore.create({ ...input, jobId: 'different-job' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('renews a live writer lease while a long result is still being produced', async () => {
    let now = new Date();
    const fixture = await createFixture('long-writer-lease', {
      now: () => now,
      leaseHeartbeatIntervalMs: 5,
    });
    const input = {
      resultId: 'result_long_writer',
      jobId: 'job-long-writer',
      columns: [{ name: 'value' }],
    };
    const writer = await fixture.store.create(input);

    now = new Date(now.getTime() + 59 * 60 * 1_000);
    await waitForLeaseHeartbeat(
      fixture.rootDir,
      input.resultId,
      'writer',
      now.toISOString(),
    );
    now = new Date(now.getTime() + 2 * 60 * 1_000);

    const contender = new ProjectDatabaseResultStore({
      projectId: fixture.projectId,
      rootDir: fixture.rootDir,
      now: () => now,
      leaseHeartbeatIntervalMs: 5,
    });
    await expect(contender.create(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await writer.append([{ value: 'eventually-produced' }]);
    await expect(writer.commit()).resolves.toMatchObject({ rowCount: 1 });
  });

  it('applies TTL and size GC without deleting a chunk still referenced by another result', async () => {
    let now = new Date('2026-08-11T12:00:00.000Z');
    const fixture = await createFixture('gc', { now: () => now });
    const sharedRows = [{ value: 'same-content' }];
    const first = await createResult(fixture.store, 'shared-a', sharedRows, {
      expiresAt: '2026-08-11T12:00:01.000Z',
    });
    now = new Date('2026-08-11T12:00:00.500Z');
    const second = await createResult(fixture.store, 'shared-b', sharedRows);
    expect(await objectFiles(fixture.rootDir)).toHaveLength(1);

    now = new Date('2026-08-11T12:00:01.000Z');
    const ttl = await fixture.store.collectGarbage({ now });
    expect(ttl).toMatchObject({ ttlResultsExpired: 1 });
    expect(await objectFiles(fixture.rootDir)).toHaveLength(1);
    await expect(fixture.store.page(first, { limit: 1 })).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(fixture.store.page(second, { limit: 1 })).resolves.toMatchObject({
      rows: sharedRows,
    });

    now = new Date('2026-08-11T12:00:02.000Z');
    const newest = await createResult(fixture.store, 'newest', [{ value: 'newest-content' }]);
    const size = await fixture.store.collectGarbage({
      now,
      maxBytes: newest.byteCount!,
    });
    expect(size.capacityResultsExpired).toBeGreaterThanOrEqual(1);
    await expect(fixture.store.page(second, { limit: 1 })).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(fixture.store.page(newest, { limit: 1 })).resolves.toMatchObject({
      rows: [{ value: 'newest-content' }],
    });
  });

  it('rejects tampered metadata and unsupported future schema versions', async () => {
    const fixture = await createFixture('metadata');
    const handle = await createResult(fixture.store, 'metadata', [{ value: 1 }]);
    const databasePath = join(fixture.rootDir, 'results.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(
        'UPDATE database_results SET checksum = ? WHERE result_id = ?',
      ).run('0'.repeat(64), handle.id);
    } finally {
      database.close();
    }
    await expect(fixture.store.page(handle, { limit: 1 })).rejects.toMatchObject({
      code: 'CORRUPT',
    });

    const futureDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-result-future-'));
    temporaryDirectories.push(futureDirectory);
    const futureRoot = join(futureDirectory, 'results');
    const seeded = new ProjectDatabaseResultStore({ projectId: 'project-future', rootDir: futureRoot });
    await seeded.inspect('missing').catch(() => undefined);
    const futureDatabase = new DatabaseSync(join(futureRoot, 'results.sqlite'));
    try {
      futureDatabase.exec('PRAGMA user_version = 999');
    } finally {
      futureDatabase.close();
    }
    const future = new ProjectDatabaseResultStore({ projectId: 'project-future', rootDir: futureRoot });
    await expect(future.inspect('missing')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
  });

  it('detects a corrupt exported artifact before yielding any bytes', async () => {
    const fixture = await createFixture('export-corruption');
    const handle = await createResult(fixture.store, 'export-corruption', [{ value: 1 }]);
    const artifact = await fixture.store.export(handle, 'jsonl');
    const exportPath = await findFileByChecksum(fixture.rootDir, artifact.checksum);
    await writeFile(exportPath, '{"value":2}\n');
    await expect(fixture.store.openExport(artifact)).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('does not mark a readable result corrupt when the export destination fails', async () => {
    const fixture = await createFixture('export-output-failure', {
      failureAt: 'during-export-write',
    });
    const handle = await createResult(fixture.store, 'export-output-failure', [{ value: 1 }]);

    await expect(fixture.store.export(handle, 'jsonl')).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    await expect(fixture.store.inspect(handle.id)).resolves.toMatchObject({
      availability: 'available',
    });
    await expect(fixture.store.page(handle, { limit: 1 })).resolves.toMatchObject({
      rows: [{ value: 1 }],
    });
  });

  it('marks a committed result corrupt when an export source chunk disappeared', async () => {
    const fixture = await createFixture('export-source-missing');
    const handle = await createResult(
      fixture.store,
      'export-source-missing',
      [{ value: 'committed' }],
    );
    await rm(await firstChunkObject(fixture.rootDir));

    await expect(fixture.store.export(handle, 'jsonl')).rejects.toMatchObject({
      code: 'CORRUPT',
      availability: 'corrupt',
      canReexecute: true,
    });
    await expect(fixture.store.inspect(handle.id)).resolves.toMatchObject({
      availability: 'corrupt',
      canReexecute: true,
    });
  });

  it('pins an opened export through streaming and eventually reclaims its tombstone', async () => {
    const fixture = await createFixture('export-lease');
    const handle = await createResult(fixture.store, 'export-lease', [{ value: 'leased' }]);
    const artifact = await fixture.store.export(handle, 'jsonl');
    const stream = await fixture.store.openExport(artifact);

    await expect(fixture.store.expire(handle.id, 'concurrent-release')).resolves.toBe(false);
    await expect(fixture.store.collectGarbage({ maxBytes: 0 })).resolves.toMatchObject({
      capacityResultsExpired: 0,
    });
    expect(await streamText(stream)).toContain('leased');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(fixture.store.expire(handle.id, 'released-after-stream')).resolves.toBe(true);
    const collected = await fixture.store.collectGarbage({ tombstoneTtlMs: 0 });
    expect(collected.tombstonesDeleted).toBe(1);
    await expect(fixture.store.inspect(handle.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('renews an export lease until a slow consumer reads or cancels the stream', async () => {
    let now = new Date();
    const fixture = await createFixture('slow-export-lease', {
      now: () => now,
      leaseHeartbeatIntervalMs: 5,
    });
    const handle = await createResult(
      fixture.store,
      'slow-export-lease',
      [{ value: 'x'.repeat(128 * 1024) }],
    );
    const artifact = await fixture.store.export(handle, 'jsonl');
    const stream = await fixture.store.openExport(artifact);

    now = new Date(now.getTime() + 59 * 60 * 1_000);
    await waitForLeaseHeartbeat(
      fixture.rootDir,
      handle.id,
      'export-read',
      now.toISOString(),
    );
    now = new Date(now.getTime() + 2 * 60 * 1_000);
    await waitForLeaseHeartbeat(
      fixture.rootDir,
      handle.id,
      'export-read',
      now.toISOString(),
    );

    await expect(fixture.store.collectGarbage({ maxBytes: 0 })).resolves.toMatchObject({
      capacityResultsExpired: 0,
    });
    await stream.cancel('consumer stopped');
    await expect(fixture.store.expire(handle.id, 'cancelled-export')).resolves.toBe(true);
  });

  it('releases an abandoned export lease after its idle deadline', async () => {
    const fixture = await createFixture('idle-export-lease');
    const handle = await createResult(fixture.store, 'idle-export-lease', [{ value: 'idle' }]);
    const artifact = await fixture.store.export(handle, 'jsonl');
    const stream = await fixture.store.openExport(artifact, { idleTimeoutMs: 10 });
    const reader = stream.getReader();

    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fixture.store.expire(handle.id, 'idle-reader')).resolves.toBe(true);
  });

  it('releases an export lease and descriptor when its AbortSignal fires', async () => {
    const fixture = await createFixture('aborted-export-lease');
    const handle = await createResult(fixture.store, 'aborted-export-lease', [{ value: 'abort' }]);
    const artifact = await fixture.store.export(handle, 'jsonl');
    const abort = new AbortController();
    const stream = await fixture.store.openExport(artifact, { signal: abort.signal });
    const reader = stream.getReader();

    abort.abort('consumer stopped');
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fixture.store.expire(handle.id, 'aborted-reader')).resolves.toBe(true);
  });

  it('includes export bytes in capacity collection and physically removes released payloads', async () => {
    const fixture = await createFixture('export-capacity');
    const handle = await createResult(
      fixture.store,
      'export-capacity',
      [{ value: 'capacity-content'.repeat(100) }],
    );
    await fixture.store.export(handle, 'csv');
    const before = (await recursiveFiles(join(fixture.rootDir, 'objects'))).length
      + (await recursiveFiles(join(fixture.rootDir, 'exports'))).length;
    expect(before).toBeGreaterThan(0);

    const report = await fixture.store.collectGarbage({
      maxBytes: handle.byteCount!,
      stagedTtlMs: 0,
    });

    expect(report.capacityResultsExpired).toBe(1);
    expect((await recursiveFiles(join(fixture.rootDir, 'objects')))
      .concat(await recursiveFiles(join(fixture.rootDir, 'exports')))).toEqual([]);
  });

  it('physically collects abandoned staging files after the staging deadline', async () => {
    const fixture = await createFixture('staging-file-gc');
    const stagingDirectory = join(fixture.rootDir, 'staging');
    const stagingPath = join(stagingDirectory, 'abandoned.tmp');
    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(stagingPath, 'abandoned');

    const report = await fixture.store.collectGarbage({
      now: new Date(Date.now() + 1_000),
      stagedTtlMs: 0,
    });

    expect(report.orphanObjectsDeleted).toBe(1);
    await expect(readFile(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects oversized identifiers, schemas, and single rows before persistence', async () => {
    const fixture = await createFixture('input-bounds');
    await expect(fixture.store.create({
      resultId: `result_${'x'.repeat(600)}`,
      jobId: 'job-bounds',
      columns: [{ name: 'value' }],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.create({
      resultId: 'result_too_many_columns',
      jobId: 'job-bounds',
      columns: Array.from({ length: 4_097 }, (_, index) => ({ name: `c${index}` })),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.create({
      resultId: 'result_long_column',
      jobId: 'job-bounds',
      columns: [{ name: '列'.repeat(400) }],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const writer = await fixture.store.create({
      resultId: 'result_oversized_row',
      jobId: 'job-bounds',
      columns: [{ name: 'value' }],
    });
    await expect(writer.append([{ value: 'x'.repeat(16 * 1024 * 1024 + 1) }]))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(writer.append([{ value: 'bounded-operation' }], {
      operationId: `operation-${'x'.repeat(600)}`,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    let nested: { [key: string]: DbColumnValue } = { leaf: 'value' };
    for (let depth = 0; depth < 65; depth += 1) nested = { child: nested };
    await expect(writer.append([{ value: nested }]))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await writer.abort();
  });

  it('normalizes an unusable metadata path as STORAGE_FAILURE', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-result-open-failure-'));
    temporaryDirectories.push(directory);
    const fileRoot = join(directory, 'not-a-directory');
    await writeFile(fileRoot, 'occupied');
    const store = new ProjectDatabaseResultStore({
      projectId: 'project-open-failure',
      rootDir: fileRoot,
    });

    await expect(store.inspect('missing')).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
  });

  it('normalizes a locked SQLite writer as STORAGE_FAILURE', async () => {
    const fixture = await createFixture('sqlite-busy');
    await fixture.store.inspect('seed').catch(() => undefined);
    const database = new DatabaseSync(join(fixture.rootDir, 'results.sqlite'));
    database.exec('BEGIN EXCLUSIVE');
    try {
      await expect(fixture.store.create({
        resultId: 'result_busy',
        jobId: 'job-busy',
        columns: [{ name: 'value' }],
      })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    } finally {
      database.exec('ROLLBACK');
      database.close();
    }
  });
});

type StoreOptions = Partial<ConstructorParameters<typeof ProjectDatabaseResultStore>[0]> & {
  failureAt?: ProjectDatabaseResultStoreFailurePoint;
};

async function createFixture(label: string, options: StoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), `schemanaut-result-fault-${label}-`));
  temporaryDirectories.push(directory);
  const rootDir = join(directory, 'results');
  const projectId = `project-${label}`;
  return {
    directory,
    rootDir,
    projectId,
    store: new ProjectDatabaseResultStore({
      projectId,
      rootDir,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
      ...options,
    }),
  };
}

async function waitForLeaseHeartbeat(
  rootDir: string,
  resultId: string,
  kind: 'writer' | 'export-read',
  expectedHeartbeat: string,
): Promise<void> {
  const database = new DatabaseSync(join(rootDir, 'results.sqlite'));
  database.exec('PRAGMA query_only = ON');
  const heartbeat = database.prepare(`
    SELECT heartbeat_at AS heartbeatAt
    FROM database_result_leases
    WHERE result_id = ? AND kind = ?
  `);
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      try {
        const row = heartbeat.get(resultId, kind) as { heartbeatAt?: unknown } | undefined;
        if (row?.heartbeatAt === expectedHeartbeat) return;
      } catch (error) {
        if ((error as { errcode?: unknown }).errcode !== 5) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    database.close();
  }
  throw new Error(`${kind} heartbeat did not reach ${expectedHeartbeat}.`);
}

async function createResult(
  store: ProjectDatabaseResultStore,
  suffix: string,
  rows: Array<Record<string, string | number>>,
  options: { expiresAt?: string } = {},
) {
  const writer = await store.create({
    resultId: `result_${suffix.replaceAll('-', '_')}`,
    jobId: `job-${suffix}`,
    columns: [{ name: 'value' }],
    ...options,
  });
  await writer.append(rows);
  return await writer.commit();
}

async function firstChunkObject(rootDir: string): Promise<string> {
  const files = await objectFiles(rootDir);
  if (files[0] === undefined) throw new Error('Expected one result object.');
  return files[0];
}

async function objectFiles(rootDir: string): Promise<string[]> {
  const objects = join(rootDir, 'objects');
  try {
    const entries = await readdir(objects, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

async function recursiveFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

async function findFileByChecksum(rootDir: string, checksum: string): Promise<string> {
  const expected = join(rootDir, 'exports', checksum.slice(0, 2), checksum.slice(2));
  const bytes = await readFile(expected);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(checksum);
  return expected;
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}
