import { describe, expect, it } from 'vitest';
import { QueryCancellationRegistry } from '../src/query-cancellation.js';

const startedAt = '2026-06-18T08:00:00.000Z';

describe('QueryCancellationRegistry', () => {
  it('registers and lists running queries by connection', () => {
    const registry = new QueryCancellationRegistry();

    const first = registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      backendPid: 1201,
      startedAt,
    });
    const second = registry.register({
      queryId: 'q2',
      connectionId: 'conn-b',
      sql: 'select 1',
      startedAt,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(registry.listRunning().map((item) => item.queryId)).toEqual(['q1', 'q2']);
    expect(registry.listRunning('conn-a').map((item) => item.queryId)).toEqual(['q1']);
  });

  it('rejects invalid registration input', () => {
    const registry = new QueryCancellationRegistry();

    expect(registry.register({ queryId: '', connectionId: 'conn', sql: 'select 1' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(
      registry.register({ queryId: 'q1', connectionId: 'conn', sql: 'select 1', backendPid: -1 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('plans PostgreSQL backend cancellation when backend pid is known', () => {
    const registry = new QueryCancellationRegistry({ fallbackDisconnectAfterMs: 5_000 });
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      backendPid: 1201,
      startedAt,
    });

    const plan = registry.requestCancel('q1', '2026-06-18T08:00:01.000Z');

    expect(plan).toMatchObject({
      ok: true,
      data: {
        queryId: 'q1',
        connectionId: 'conn-a',
        decision: 'cancel-backend',
        backendPid: 1201,
        retryAfterMs: 5_000,
      },
    });
    expect(registry.get('q1')?.status).toBe('cancel-requested');
  });

  it('keeps backend cancellation as the first action before fallback timeout', () => {
    const registry = new QueryCancellationRegistry({ fallbackDisconnectAfterMs: 5_000 });
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      backendPid: 1201,
      startedAt,
    });

    registry.requestCancel('q1', '2026-06-18T08:00:01.000Z');
    const plan = registry.requestCancel('q1', '2026-06-18T08:00:03.000Z');

    expect(plan).toMatchObject({
      ok: true,
      data: {
        decision: 'cancel-backend',
        backendPid: 1201,
        retryAfterMs: 3_000,
      },
    });
  });

  it('falls back to disconnecting the current connection after cancel timeout', () => {
    const registry = new QueryCancellationRegistry({ fallbackDisconnectAfterMs: 5_000 });
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      backendPid: 1201,
      startedAt,
    });

    registry.requestCancel('q1', '2026-06-18T08:00:01.000Z');
    const plan = registry.requestCancel('q1', '2026-06-18T08:00:06.000Z');

    expect(plan).toMatchObject({
      ok: true,
      data: {
        queryId: 'q1',
        connectionId: 'conn-a',
        decision: 'disconnect-connection',
      },
    });
  });

  it('falls back to connection teardown when backend pid is unavailable', () => {
    const registry = new QueryCancellationRegistry();
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      startedAt,
    });

    const plan = registry.requestCancel('q1', '2026-06-18T08:00:01.000Z');

    expect(plan).toMatchObject({
      ok: true,
      data: {
        decision: 'disconnect-connection',
        connectionId: 'conn-a',
      },
    });
  });

  it('does not cancel queries that already finished', () => {
    const registry = new QueryCancellationRegistry();
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select 1',
      backendPid: 1201,
      startedAt,
    });
    registry.markCompleted('q1', '2026-06-18T08:00:02.000Z');

    const plan = registry.requestCancel('q1', '2026-06-18T08:00:03.000Z');

    expect(plan).toMatchObject({
      ok: true,
      data: {
        decision: 'already-finished',
      },
    });
    expect(registry.listRunning()).toEqual([]);
  });

  it('marks cancelled and failed queries for audit', () => {
    const registry = new QueryCancellationRegistry();
    registry.register({
      queryId: 'q1',
      connectionId: 'conn-a',
      sql: 'select pg_sleep(30)',
      backendPid: 1201,
      startedAt,
    });
    registry.register({
      queryId: 'q2',
      connectionId: 'conn-a',
      sql: 'select * from missing_table',
      startedAt,
    });

    const cancelled = registry.markCancelled('q1', '2026-06-18T08:00:04.000Z');
    const failed = registry.markFailed('q2', 'relation "missing_table" does not exist', '2026-06-18T08:00:05.000Z');

    expect(cancelled).toMatchObject({
      ok: true,
      data: { status: 'cancelled', cancelledAt: '2026-06-18T08:00:04.000Z' },
    });
    expect(failed).toMatchObject({
      ok: true,
      data: {
        status: 'failed',
        failedAt: '2026-06-18T08:00:05.000Z',
        errorMessage: 'relation "missing_table" does not exist',
      },
    });
    expect(registry.listRunning()).toEqual([]);
  });

  it('prunes finished records after retention window', () => {
    const registry = new QueryCancellationRegistry();
    registry.register({ queryId: 'q1', connectionId: 'conn-a', sql: 'select 1', startedAt });
    registry.register({ queryId: 'q2', connectionId: 'conn-a', sql: 'select pg_sleep(30)', startedAt });
    registry.markCompleted('q1', '2026-06-18T08:00:02.000Z');

    expect(registry.pruneFinished(10_000, '2026-06-18T08:00:13.000Z')).toBe(1);
    expect(registry.get('q1')).toBeUndefined();
    expect(registry.get('q2')?.status).toBe('running');
  });

  it('returns not-found plan for unknown query id', () => {
    const registry = new QueryCancellationRegistry();

    expect(registry.requestCancel('missing')).toMatchObject({
      ok: true,
      data: {
        decision: 'not-found',
      },
    });
  });
});
