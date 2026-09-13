import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  err,
  ok,
  parsePublicJson,
  type ConnectionProfile,
  type DurableResultHandle,
  type QueryJob,
  type QueryResultRow,
  type ResultBatch,
  type SavedConnection,
} from '@dbagent/shared';
import type { DatabaseConnector } from '../src/connector.js';
import type { QueryExecutionObserver } from '../src/types.js';
import { ConnectorRegistry } from '../src/connector-registry.js';
import {
  DatabaseAccessRuntime,
  DatabaseAccessRuntimeError,
} from '../src/database-access-runtime.js';
import { PostgresConnector } from '../src/postgres-connector.js';
import type { PostgresConnectorDriver, PostgresServerInfo } from '../src/postgres-driver.js';
import { ProjectDatabaseResultStore } from '../src/project-result-store.js';
import { DatabaseResultStoreError } from '../src/result-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOTEMPTY' || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }));
});

describe('ProjectDatabaseResultStore', { timeout: 30_000 }, () => {
  it('pages portable values and chunk boundaries after a complete runtime restart', async () => {
    const fixture = await createStoreFixture('restart', { chunkMaxRows: 2 });
    const rows: QueryResultRow[] = [
      { id: 1, name: 'alpha', value: 9_007_199_254_740_993n },
      { id: 2, name: '中文', occurredAt: new Date('2026-08-11T00:00:00.000Z') },
      { id: 3, name: 'binary', payload: Uint8Array.from([0, 127, 255]) },
      { id: 4, name: 'nested', payload: { tags: ['a', 'b'], active: true } },
      { id: 5, name: 'omega', value: null },
    ];
    const writer = await fixture.store.create({
      resultId: 'result_restart',
      jobId: 'job-restart',
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'value' }],
      expiresAt: '2026-08-12T00:00:00.000Z',
    });
    await writer.append(rows.slice(0, 3));
    await writer.append(rows.slice(3));
    const handle = await writer.commit();

    expect(handle).toMatchObject({
      schemaVersion: 1,
      scheme: 'schemanaut.database-result',
      projectId: 'project-restart',
      id: 'result_restart',
      jobId: 'job-restart',
      availability: 'available',
      rowCount: 5,
    });
    expect(handle.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(handle)).not.toContain(fixture.directory);

    const reopened = new ProjectDatabaseResultStore({
      projectId: 'project-restart', rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });
    const middle = await reopened.page(handle.id, { offset: 1, limit: 2 });
    expect(middle.columns.map(({ name }) => name)).toEqual(['id', 'name', 'value']);
    expect(middle).toMatchObject({
      handleId: handle.id,
      rowOffset: 1,
      rows: rows.slice(1, 3),
      nextOffset: 3,
      complete: false,
    });
    expect(middle.nextCursor).toEqual(expect.any(String));
    await expect(reopened.page(handle, { cursor: middle.nextCursor, limit: 10 }))
      .resolves.toMatchObject({
        rowOffset: 3,
        rows: rows.slice(3),
        complete: true,
      });
  });

  it('exports complete CSV and JSONL artifacts that remain readable after restart', async () => {
    const fixture = await createStoreFixture('export', { chunkMaxRows: 1 });
    const rows: QueryResultRow[] = [
      { id: 1, name: 'Alice', note: 'hello, "world"' },
      { id: 2, name: '张三', note: 'line1\nline2' },
    ];
    const writer = await fixture.store.create({
      resultId: 'result_export', jobId: 'job-export',
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
    });
    await writer.append(rows);
    const handle = await writer.commit();

    const csv = await fixture.store.export(handle, 'csv');
    const jsonl = await fixture.store.export(handle.id, 'jsonl');
    expect(csv).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-export',
      availability: 'available',
      mediaType: 'text/csv; charset=utf-8',
    });
    expect(jsonl.mediaType).toBe('application/x-ndjson; charset=utf-8');
    expect(csv.checksum).toMatch(/^[a-f0-9]{64}$/u);

    const reopened = new ProjectDatabaseResultStore({
      projectId: 'project-export', rootDir: fixture.rootDir,
    });
    const csvText = await streamText(await reopened.openExport(csv));
    expect(csvText).toBe('id,name,note\r\n1,Alice,"hello, ""world"""\r\n2,张三,"line1\nline2"\r\n');
    const jsonLines = (await streamText(await reopened.openExport(jsonl))).trim().split('\n');
    expect(jsonLines.map((line) => parsePublicJson(line))).toEqual(rows);
  });

  it('replays the exact same artifact reference when an export response is retried later', async () => {
    let now = new Date('2026-08-11T12:00:00.000Z');
    const fixture = await createStoreFixture('export-replay', { now: () => now });
    const handle = await createResult(fixture.store, 'export-replay', [{ value: 'stable' }]);
    const first = await fixture.store.export(handle, 'jsonl');

    now = new Date('2026-08-11T13:00:00.000Z');
    const second = await fixture.store.export(handle, 'jsonl');

    expect(second).toEqual(first);
  });

  it('binds cursors to one handle and rejects malformed or ambiguous page requests', async () => {
    const fixture = await createStoreFixture('cursor', { chunkMaxRows: 2 });
    const first = await createResult(fixture.store, 'cursor-a', [
      { value: 1 }, { value: 2 }, { value: 3 },
    ]);
    const second = await createResult(fixture.store, 'cursor-b', [{ value: 4 }]);
    const page = await fixture.store.page(first, { limit: 1 });

    await expect(fixture.store.page(second, { cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    await expect(fixture.store.page(first, { cursor: 'not-a-canonical-cursor' }))
      .rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    await expect(fixture.store.page(first, { cursor: page.nextCursor, offset: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.page(first, { limit: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.page(first, { limit: 1_001 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.page(first, { offset: 4 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.store.page({ ...first, checksum: '0'.repeat(64) }, { limit: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects a replay identity whose retention or result flags differ', async () => {
    const fixture = await createStoreFixture('identity-replay');
    const input = {
      resultId: 'result_identity_replay',
      jobId: 'job-identity-replay',
      columns: [{ name: 'value' }],
      hasMore: false,
      truncated: false,
      expiresAt: '2026-08-12T00:00:00.000Z',
    };
    const writer = await fixture.store.create(input);
    await writer.append([{ value: 1 }]);
    await writer.commit();

    await expect(fixture.store.create({ ...input, hasMore: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(fixture.store.create({
      ...input,
      expiresAt: '2026-08-13T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns typed expiry with a re-execution signal instead of a superficially valid handle', async () => {
    let now = new Date('2026-08-11T12:00:00.000Z');
    const fixture = await createStoreFixture('expiry', { now: () => now });
    const writer = await fixture.store.create({
      resultId: 'result_expiry', jobId: 'job-expiry', columns: [{ name: 'value' }],
      expiresAt: '2026-08-11T12:00:01.000Z',
    });
    await writer.append([{ value: 1 }]);
    const handle = await writer.commit();
    await expect(fixture.store.page(handle, { limit: 1 })).resolves.toMatchObject({
      rows: [{ value: 1 }],
    });

    now = new Date('2026-08-11T12:00:01.000Z');
    await expect(fixture.store.page(handle.id, { limit: 1 })).rejects.toMatchObject({
      code: 'EXPIRED', availability: 'expired', canReexecute: true,
    });
    await expect(fixture.store.inspect(handle.id)).resolves.toMatchObject({
      availability: 'expired', canReexecute: true,
    });
  });

  it('lets DatabaseAccessRuntime page a PostgresConnector result without old runtime state', async () => {
    const fixture = await createStoreFixture('runtime-restart', { chunkMaxRows: 2 });
    const profile = postgresProfile('profile-runtime-restart');
    const firstConnectors = new ConnectorRegistry();
    const connector = new PostgresConnector(postgresFixtureDriver(), {
      resultStore: fixture.store,
    });
    firstConnectors.register(connector);
    const first = new DatabaseAccessRuntime({
      connectors: firstConnectors,
      resultStore: fixture.store,
    });
    first.createProfile(profile);
    await first.connect(profile.id);
    const job = await first.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      authorization: { authorizedClass: 'query' },
    });
    expect(job.state).toBe('succeeded');
    expect(job.result).toBeDefined();

    const reopenedStore = new ProjectDatabaseResultStore({
      projectId: 'project-runtime-restart', rootDir: fixture.rootDir,
    });
    const secondConnectors = new ConnectorRegistry();
    secondConnectors.register(new PostgresConnector(postgresFixtureDriver(), {
      resultStore: reopenedStore,
    }));
    const second = new DatabaseAccessRuntime({
      connectors: secondConnectors,
      resultStore: reopenedStore,
    });
    await expect(second.readResult(job.result!.id, { limit: 2 })).resolves.toMatchObject({
      rowOffset: 0,
      rows: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
      complete: false,
    });
    const artifact = await second.exportResult(job.result!.id, 'jsonl');
    expect(artifact).toMatchObject({
      availability: 'available',
    });
    const exported = await new Response(await second.openResultExport(artifact)).text();
    expect(exported).toContain('"name":"one"');

    await expect(first.releaseResult(job.result!.id)).resolves.toBe(true);
    await expect(connector.releaseResult({ profile }, job.result!.id)).resolves.toBe(false);
    const releasedJob = await connector.getJob({ profile }, job.id);
    expect(releasedJob.state).toBe('succeeded');
    expect(releasedJob.result).toBeUndefined();
  });

  it('exports every streamed driver batch while keeping the requested preview bounded', async () => {
    const fixture = await createStoreFixture('runtime-complete-stream', { chunkMaxRows: 2 });
    const profile = postgresProfile('profile-runtime-complete-stream');
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresStreamingFixtureDriver(), {
      resultStore: fixture.store,
    }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      rowLimit: 2,
      batchSize: 2,
      authorization: { authorizedClass: 'query' },
    });

    expect(job).toMatchObject({
      state: 'succeeded',
      result: { rowCount: 5, hasMore: false, truncated: false },
    });
    await expect(runtime.readResult(job.result!.id, { limit: 2 })).resolves.toMatchObject({
      rows: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
      complete: false,
    });
    const artifact = await runtime.exportResult(job.result!.id, 'jsonl');
    const exported = (await new Response(await runtime.openResultExport(artifact)).text())
      .trim()
      .split('\n')
      .map((line) => parsePublicJson(line));
    expect(exported).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
      { id: 4, name: 'four' },
      { id: 5, name: 'five' },
    ]);
  });

  it('retries a lost streamed append response by operation identity without duplicate rows', async () => {
    const fixture = await createStoreFixture('runtime-stream-append-response-loss', {
      chunkMaxRows: 2,
      failureAt: 'after-append-metadata-before-response',
    });
    const profile = postgresProfile('profile-runtime-stream-append-response-loss');
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresStreamingFixtureDriver(), {
      resultStore: fixture.store,
    }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      rowLimit: 2,
      batchSize: 2,
      authorization: { authorizedClass: 'query' },
    });

    expect(job).toMatchObject({ state: 'succeeded', result: { rowCount: 5 } });
    const artifact = await runtime.exportResult(job.result!.id, 'jsonl');
    const exported = (await new Response(await runtime.openResultExport(artifact)).text())
      .trim()
      .split('\n');
    expect(exported).toHaveLength(5);
    expect(exported.map((line) => parsePublicJson(line))).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
      { id: 4, name: 'four' },
      { id: 5, name: 'five' },
    ]);
  });

  it('cleans a staged streamed result when the database fails after yielding a batch', async () => {
    const fixture = await createStoreFixture('runtime-stream-database-failure');
    const profile = postgresProfile('profile-runtime-stream-database-failure');
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresStreamingFailureFixtureDriver(), {
      resultStore: fixture.store,
    }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      authorization: { authorizedClass: 'query' },
    });

    expect(job).toMatchObject({
      state: 'failed',
      error: { code: 'QUERY_FAILED', category: 'provider', stage: 'execute' },
    });
    await expect(fixture.store.inspect(`result_${job.id}`)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('materializes a custom connector result into the project store at the Runtime boundary', async () => {
    const fixture = await createStoreFixture('runtime-custom-connector');
    const profile: ConnectionProfile = {
      ...postgresProfile('profile-runtime-custom-connector'),
      connectorId: 'custom-result-source',
      engine: 'custom',
    };
    const connectors = new ConnectorRegistry();
    connectors.register(customResultConnector());
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      authorization: { authorizedClass: 'query' },
    });
    const reopened = new ProjectDatabaseResultStore({
      projectId: fixture.projectId,
      rootDir: fixture.rootDir,
    });
    await expect(reopened.getHandle(job.result!.id)).resolves.toMatchObject({
      id: job.result!.id,
      rowCount: 3,
      availability: 'available',
    });
  });

  it('rejects a custom connector result identity that resolves to another job', async () => {
    const fixture = await createStoreFixture('runtime-custom-identity-conflict');
    const conflicting = await fixture.store.create({
      resultId: 'custom-source-result-1',
      jobId: 'different-job',
      columns: [{ name: 'id' }, { name: 'name' }],
    });
    await conflicting.append([{ id: 999, name: 'wrong result' }]);
    await conflicting.commit();
    const profile: ConnectionProfile = {
      ...postgresProfile('profile-runtime-custom-identity-conflict'),
      connectorId: 'custom-result-source',
      engine: 'custom',
    };
    const connectors = new ConnectorRegistry();
    connectors.register(customResultConnector());
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    await expect(runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      authorization: { authorizedClass: 'query' },
    })).rejects.toMatchObject({
      error: { code: 'RESULT_CONFLICT', category: 'conflict', outcome: 'unchanged' },
    });
  });

  it('preserves STORAGE_FAILURE when the Runtime materializes a custom connector result', async () => {
    const fixture = await createStoreFixture('runtime-custom-storage-failure', {
      failureAt: 'after-result-create-before-response',
    });
    const profile: ConnectionProfile = {
      ...postgresProfile('profile-runtime-custom-storage-failure'),
      connectorId: 'custom-result-source',
      engine: 'custom',
    };
    const connectors = new ConnectorRegistry();
    connectors.register(customResultConnector());
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    await expect(runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture order by id',
      authorization: { authorizedClass: 'query' },
    })).rejects.toMatchObject({
      error: {
        code: 'STORAGE_FAILURE',
        category: 'internal',
        stage: 'submit',
        retryable: true,
        outcome: 'unchanged',
      },
    });
  });

  it('keeps two projects isolated when their stores share one physical root', async () => {
    const fixture = await createStoreFixture('shared-root-project-isolation');
    const second = new ProjectDatabaseResultStore({
      projectId: 'project-shared-root-second',
      rootDir: fixture.rootDir,
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });
    const firstHandle = await createResult(fixture.store, 'shared_root_first', [{ value: 'first' }]);
    const secondHandle = await createResult(second, 'shared_root_second', [{ value: 'second' }]);

    await fixture.store.collectGarbage({ maxResults: 0, tombstoneTtlMs: 0 });
    await expect(fixture.store.getHandle(firstHandle.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(second.page(secondHandle.id, { limit: 10 })).resolves.toMatchObject({
      rows: [{ value: 'second' }],
    });
    await expect(fixture.store.page(secondHandle.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(second.page(firstHandle.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accepts only the same result-store instance when completing Runtime composition', async () => {
    const first = await createStoreFixture('runtime-store-attachment-first');
    const second = await createStoreFixture('runtime-store-attachment-second');
    const runtime = new DatabaseAccessRuntime({ resultStore: first.store });

    expect(() => runtime.attachResultStore(first.store)).not.toThrow();
    let conflict: unknown;
    try {
      runtime.attachResultStore(second.store);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(DatabaseAccessRuntimeError);
    expect((conflict as DatabaseAccessRuntimeError).error).toMatchObject({
      code: 'RESULT_STORE_ALREADY_CONFIGURED',
      category: 'conflict',
      stage: 'result',
    });
  });

  it('recovers a write result through DatabaseAccessRuntime when commit succeeded but its response was lost', async () => {
    const fixture = await createStoreFixture('runtime-commit-response-loss', {
      failureAt: 'after-result-commit-before-response',
    });
    const profile = postgresProfile('profile-runtime-commit-response-loss', false);
    let executions = 0;
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresFixtureDriver({
      onExecute: () => { executions += 1; },
    }), { resultStore: fixture.store }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: "update durable_fixture set name = 'changed' where id = 1 returning id, name",
      authorization: { authorizedClass: 'mutation' },
    });

    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({ availability: 'available', rowCount: 3 });
    expect(executions).toBe(1);
    await expect(runtime.readResult(job.result!.id, { limit: 10 })).resolves.toMatchObject({
      rows: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
        { id: 3, name: 'three' },
      ],
    });
  });

  it.each([
    'after-result-create-before-response',
    'after-chunk-object-before-metadata',
    'after-append-metadata-before-response',
    'after-chunk-metadata-before-result-commit',
  ] as const)(
    'turns a post-execution %s crash into a recoverable sync terminal job and cleans staging',
    async (failureAt) => {
    const fixture = await createStoreFixture(`runtime-sync-${failureAt}`, {
      failureAt,
    });
    const profile = postgresProfile('profile-runtime-sync-persistence-failure');
    let executions = 0;
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresFixtureDriver({
      onExecute: () => { executions += 1; },
    }), { resultStore: fixture.store }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture',
      authorization: { authorizedClass: 'query' },
    });

    expect(job).toMatchObject({
      state: 'failed',
      error: {
        code: 'STORAGE_FAILURE',
        category: 'internal',
        stage: 'result',
        retryable: true,
        outcome: 'unknown',
      },
    });
    expect(executions).toBe(1);
    await expect(fixture.store.inspect(`result_${job.id}`)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(fixture.store.collectGarbage({ stagedTtlMs: 0 })).resolves.toBeDefined();
    },
  );

  it.each([
    'after-result-create-before-response',
    'after-chunk-object-before-metadata',
    'after-append-metadata-before-response',
    'after-chunk-metadata-before-result-commit',
  ] as const)('settles an async %s crash without an unhandled rejection', async (failureAt) => {
    const fixture = await createStoreFixture(`runtime-async-${failureAt}`, {
      failureAt,
    });
    const profile = postgresProfile('profile-runtime-async-persistence-failure');
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresFixtureDriver(), {
      resultStore: fixture.store,
    }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const queued = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture',
      executionMode: 'async',
      authorization: { authorizedClass: 'query' },
    });
    const terminal = await waitForTerminalJob(runtime, queued.id);

    expect(terminal).toMatchObject({
      state: 'failed',
      error: { code: 'STORAGE_FAILURE', outcome: 'unknown' },
    });
  });

  it('recovers an async commit response loss without re-executing the database', async () => {
    const fixture = await createStoreFixture('runtime-async-commit-response-loss', {
      failureAt: 'after-result-commit-before-response',
    });
    const profile = postgresProfile('profile-runtime-async-commit-response-loss', false);
    let executions = 0;
    const connectors = new ConnectorRegistry();
    connectors.register(new PostgresConnector(postgresFixtureDriver({
      onExecute: () => { executions += 1; },
    }), { resultStore: fixture.store }));
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);

    const queued = await runtime.submit({
      profileId: profile.id,
      sql: "update durable_fixture set name = 'async' where id = 1 returning id, name",
      executionMode: 'async',
      authorization: { authorizedClass: 'mutation' },
    });
    const terminal = await waitForTerminalJob(runtime, queued.id);

    expect(terminal).toMatchObject({ state: 'succeeded', result: { availability: 'available' } });
    expect(executions).toBe(1);
  });

  it('keeps a runtime result readable until its exported stream is cancelled and the lease releases', async () => {
    const fixture = await createStoreFixture('runtime-eviction-lease');
    const profile = postgresProfile('profile-runtime-eviction-lease');
    const connector = new PostgresConnector(postgresFixtureDriver(), { resultStore: fixture.store });
    const connectors = new ConnectorRegistry();
    connectors.register(connector);
    const runtime = new DatabaseAccessRuntime({ connectors, resultStore: fixture.store });
    runtime.createProfile(profile);
    await runtime.connect(profile.id);
    const job = await runtime.submit({
      profileId: profile.id,
      sql: 'select id, name from durable_fixture',
      authorization: { authorizedClass: 'query' },
    });
    const artifact = await runtime.exportResult(job.result!.id, 'jsonl');
    const stream = await runtime.openResultExport(artifact);

    await expect(runtime.releaseResult(job.result!.id)).resolves.toBe(false);
    await expect(runtime.readResult(job.result!.id, { limit: 1 })).resolves.toMatchObject({
      rows: [{ id: 1, name: 'one' }],
    });
    await stream.cancel();
    await expect(runtime.releaseResult(job.result!.id)).resolves.toBe(true);
    await expect(runtime.readResult(job.result!.id, { limit: 1 })).rejects.toMatchObject({
      error: { code: 'RESULT_EXPIRED', outcome: 'unchanged' },
    });
  });

  it('uses one recoverable explicitly injected store identity across connector instances', async () => {
    const fixture = await createStoreFixture('connector-shared-default');
    const firstProfile = postgresProfile('profile-default-one');
    const secondProfile = postgresProfile('profile-default-two');
    const first = new PostgresConnector(postgresFixtureDriver(), { resultStore: fixture.store });
    const second = new PostgresConnector(postgresFixtureDriver(), {
      resultStore: new ProjectDatabaseResultStore({
        projectId: fixture.projectId,
        rootDir: fixture.rootDir,
        now: () => new Date('2026-08-11T12:00:00.000Z'),
      }),
    });
    await first.connect({ profile: firstProfile });
    await second.connect({ profile: secondProfile });
    const firstJob = await first.submit({ profile: firstProfile }, {
      profileId: firstProfile.id, sql: 'select 1',
      authorization: { authorizedClass: 'query' },
    });
    const secondJob = await second.submit({ profile: secondProfile }, {
      profileId: secondProfile.id, sql: 'select 2',
      authorization: { authorizedClass: 'query' },
    });
    expect(firstJob).toMatchObject({ state: 'succeeded' });
    expect(secondJob).toMatchObject({ state: 'succeeded' });
    const firstHandle = firstJob.result as DurableResultHandle;
    const secondHandle = secondJob.result as DurableResultHandle;
    expect(firstHandle.projectId).toBe(fixture.projectId);
    expect(secondHandle.projectId).toBe(firstHandle.projectId);
  });

  it('preserves result-store fault categories at the connector boundary', async () => {
    const fixture = await createStoreFixture('error-mapping');
    const profile = postgresProfile('profile-error-mapping');
    const connector = new PostgresConnector(postgresFixtureDriver(), { resultStore: fixture.store });
    await connector.connect({ profile });
    const job = await connector.submit({ profile }, {
      profileId: profile.id, sql: 'select 1', authorization: { authorizedClass: 'query' },
    });
    Object.defineProperty(fixture.store, 'page', {
      configurable: true,
      value: () => Promise.reject(new DatabaseResultStoreError(
        'UNSUPPORTED_SCHEMA', 'future result-store schema',
      )),
    });
    await expect(connector.readResult({ profile }, job.result!.id)).rejects.toMatchObject({
      databaseError: {
        code: 'RESULT_STORE_SCHEMA_UNSUPPORTED',
        category: 'unsupported',
      },
    });
  });

  it.each([
    ['EXPIRED', 'RESULT_EXPIRED', 'not-found', false],
    ['CORRUPT', 'RESULT_CORRUPT', 'provider', false],
    ['INVALID_ARGUMENT', 'RESULT_REQUEST_INVALID', 'validation', false],
  ] as const)(
    'preserves %s from the durable store through DatabaseAccessRuntime',
    async (storeCode, runtimeCode, category, retryable) => {
      const resultStore = {
        page: () => Promise.reject(new DatabaseResultStoreError(storeCode, storeCode)),
      } as unknown as ProjectDatabaseResultStore;
      const runtime = new DatabaseAccessRuntime({ resultStore });
      await expect(runtime.readResult('result_typed')).rejects.toMatchObject({
        error: { code: runtimeCode, category, retryable, outcome: 'unchanged' },
      });
    },
  );

  it('preserves a typed store error when durable release cannot inspect storage', async () => {
    const resultStore = {
      expire: () => Promise.reject(new DatabaseResultStoreError(
        'CORRUPT',
        'release metadata is corrupt',
      )),
    } as unknown as ProjectDatabaseResultStore;
    const runtime = new DatabaseAccessRuntime({ resultStore });

    await expect(runtime.releaseResult('result_release_error')).rejects.toMatchObject({
      error: {
        code: 'RESULT_CORRUPT',
        category: 'provider',
        stage: 'result',
        outcome: 'unchanged',
      },
    });
  });
});

type StoreOptions = Partial<ConstructorParameters<typeof ProjectDatabaseResultStore>[0]>;

async function createStoreFixture(label: string, options: StoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), `schemanaut-result-store-${label}-`));
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

async function createResult(
  store: ProjectDatabaseResultStore,
  suffix: string,
  rows: QueryResultRow[],
) {
  const writer = await store.create({
    resultId: `result_${suffix}`, jobId: `job-${suffix}`, columns: [{ name: 'value' }],
  });
  await writer.append(rows);
  return await writer.commit();
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function postgresProfile(id: string, readOnly = true): ConnectionProfile {
  return {
    id,
    name: 'Durable PostgreSQL',
    connectorId: 'postgres-native',
    engine: 'postgres',
    endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'durable' }],
    principal: 'tester',
    purpose: readOnly ? 'read-only' : 'read-write',
    readOnly,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function postgresDriverFixture(
  overrides: Partial<PostgresConnectorDriver> = {},
): PostgresConnectorDriver {
  const unavailable = () => Promise.reject(new Error('Unexpected PostgreSQL fixture operation.'));
  return {
    test: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    execute: unavailable,
    cancel: unavailable,
    serverInfo: unavailable,
    discoverCatalog: unavailable,
    runtimeSnapshot: unavailable,
    terminateBackend: unavailable,
    maintainTable: unavailable,
    beginTransaction: unavailable,
    executeInTransaction: unavailable,
    createSavepoint: unavailable,
    rollbackToSavepoint: unavailable,
    commitTransaction: unavailable,
    rollbackTransaction: unavailable,
    ...overrides,
  };
}

function postgresFixtureDriver(options: { onExecute?: () => void } = {}): PostgresConnectorDriver {
  const connection: SavedConnection = {
    id: 'pg_durable_fixture',
    name: 'Durable PostgreSQL',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'durable',
    username: 'tester',
    readOnly: false,
    status: 'connected',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
  const serverInfo: PostgresServerInfo = {
    database: 'durable', currentUser: 'tester', engineVersion: '16.3',
    engineVersionNumber: 160_003, inRecovery: false,
  };
  return postgresDriverFixture({
    connect: () => Promise.resolve(ok(connection)),
    serverInfo: () => Promise.resolve(ok(serverInfo)),
    execute: () => {
      options.onExecute?.();
      return Promise.resolve(ok({
      queryId: 'query-durable',
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
        { id: 3, name: 'three' },
      ],
      rowCount: 3,
      elapsedMs: 1,
      safety: {
        statementKind: 'SELECT', riskLevel: 'safe' as const,
        requiresConfirmation: false, blocked: false, reasons: [],
      },
      }));
    },
  });
}

function postgresStreamingFixtureDriver(): PostgresConnectorDriver {
  const driver = postgresFixtureDriver();
  return postgresDriverFixture({
    ...driver,
    execute: async (
      _request: unknown,
      _connection: unknown,
      observer?: QueryExecutionObserver,
    ) => {
      await observer?.onResultBatch?.({
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
        ordinal: 0,
      });
      await observer?.onResultBatch?.({
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 3, name: 'three' }, { id: 4, name: 'four' }],
        ordinal: 1,
      });
      await observer?.onResultBatch?.({
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 5, name: 'five' }],
        ordinal: 2,
      });
      return ok({
        queryId: 'query-streamed-durable',
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
        rowCount: 5,
        returnedRowCount: 2,
        rowLimit: 2,
        hasMore: false,
        truncated: false,
        elapsedMs: 1,
        safety: {
          statementKind: 'SELECT', riskLevel: 'safe' as const,
          requiresConfirmation: false, blocked: false, reasons: [],
        },
      });
    },
  });
}

function postgresStreamingFailureFixtureDriver(): PostgresConnectorDriver {
  const driver = postgresFixtureDriver();
  return postgresDriverFixture({
    ...driver,
    execute: async (
      _request: unknown,
      _connection: unknown,
      observer?: QueryExecutionObserver,
    ) => {
      await observer?.onResultBatch?.({
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 1, name: 'one' }],
        ordinal: 0,
      });
      return err({
        code: 'QUERY_FAILED',
        message: 'The database cursor failed after its first batch.',
      });
    },
  });
}

function customResultConnector(): DatabaseConnector {
  const rows = [
    { id: 1, name: 'one' },
    { id: 2, name: 'two' },
    { id: 3, name: 'three' },
  ];
  const jobs = new Map<string, QueryJob>();
  return {
    manifest: {
      id: 'custom-result-source',
      displayName: 'Custom result source',
      version: '1.0.0',
      engine: 'custom',
      transports: ['tcp'],
      execution: 'synchronous',
      capabilities: {
        'sql.query': {
          key: 'sql.query', status: 'supported', source: 'custom',
          observedAt: '2026-08-11T12:00:00.000Z',
        },
      },
      operations: [],
    },
    test: ({ profile }) => Promise.resolve({
      profileId: profile.id,
      connectorId: 'custom-result-source',
      engine: 'custom',
      status: 'healthy',
      latencyMs: 1,
      checkedAt: '2026-08-11T12:00:00.000Z',
    }),
    connect: ({ profile }) => Promise.resolve({
      id: `session-${profile.id}`,
      connectionId: `connection-${profile.id}`,
      profileId: profile.id,
      connectorId: 'custom-result-source',
      status: 'connected',
      endpointIndex: 0,
      connectedAt: '2026-08-11T12:00:00.000Z',
      generation: 1,
    }),
    disconnect: () => Promise.resolve(undefined),
    health: () => Promise.resolve({ status: 'healthy', checkedAt: '2026-08-11T12:00:00.000Z' }),
    capabilities: ({ profile }) => Promise.resolve({
      connectorId: 'custom-result-source',
      engine: 'custom',
      connectionProfileId: profile.id,
      resolvedAt: '2026-08-11T12:00:00.000Z',
      capabilities: {
        'sql.query': {
          key: 'sql.query', status: 'supported', source: 'custom',
          observedAt: '2026-08-11T12:00:00.000Z',
        },
      },
    }),
    discover: () => Promise.resolve({ resources: [], relations: [], complete: true }),
    submit: ({ profile }) => {
      const job: QueryJob = {
        id: 'custom-job-1', profileId: profile.id, connectorId: 'custom-result-source',
        state: 'succeeded', submittedAt: '2026-08-11T12:00:00.000Z',
        completedAt: '2026-08-11T12:00:00.000Z',
        result: {
          id: 'custom-source-result-1', jobId: 'custom-job-1', format: 'rows',
          columns: [{ name: 'id' }, { name: 'name' }], rowCount: rows.length,
        },
      };
      jobs.set(job.id, job);
      return Promise.resolve(job);
    },
    getJob: (_context, jobId) => Promise.resolve(jobs.get(jobId)!),
    cancel: (_context, jobId) => Promise.resolve(jobs.get(jobId)!),
    readResult: (_context, handleId, input = {}): Promise<ResultBatch> => {
      const offset = Number(input.cursor ?? 0);
      const limit = input.limit ?? 2;
      const page = rows.slice(offset, offset + limit);
      const next = offset + page.length;
      return Promise.resolve({
        handleId, rows: page, rowOffset: offset, complete: next >= rows.length,
        ...(next < rows.length ? { nextCursor: String(next) } : {}),
      });
    },
    releaseResult: () => Promise.resolve(true),
  };
}

async function waitForTerminalJob(
  runtime: DatabaseAccessRuntime,
  jobId: string,
): Promise<Awaited<ReturnType<DatabaseAccessRuntime['getJob']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await runtime.getJob(jobId);
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Query job did not reach a terminal state: ${jobId}`);
}
