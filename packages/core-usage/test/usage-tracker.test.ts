import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '@dbagent/shared';
import { UsageTracker, UsageTrackerStateError } from '../src/usage-tracker.js';

const tempDirs: string[] = [];

async function historyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-usage-'));
  tempDirs.push(dir);
  return join(dir, 'state', 'usage-history.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('UsageTracker', () => {
  it('returns a BYOK zero-use snapshot when no direct usage or projection exists', async () => {
    const current = await new UsageTracker(await historyPath()).current();

    expect(current).toMatchObject({ mode: 'byok', totalTokens: 0 });
    expect(Date.parse(current.windowStartedAt)).not.toBeNaN();
  });

  it('records direct provider token usage', async () => {
    const tracker = new UsageTracker(await historyPath());

    await tracker.recordTokens('byok', { promptTokens: 30, completionTokens: 7, totalTokens: 37 });

    await expect(tracker.current()).resolves.toMatchObject({
      mode: 'byok', promptTokens: 30, completionTokens: 7, totalTokens: 37,
    });
  });

  it('projects an authoritative source as an absolute total without changing direct history', async () => {
    const tracker = new UsageTracker(await historyPath());
    await tracker.recordTokens('byok', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const release = tracker.attachAbsoluteProjection({
      sourceKey: 'journal:C:/project-a/.schemanaut/state.db',
      getSnapshot: () => Promise.resolve(snapshot({ promptTokens: 40, completionTokens: 20, totalTokens: 60 })),
    });

    await expect(tracker.current()).resolves.toMatchObject({
      mode: 'byok', promptTokens: 50, completionTokens: 25, totalTokens: 75,
    });
    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 75 });
    await expect(tracker.directHistory()).resolves.toHaveLength(1);

    release();
    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 15 });
  });

  it('counts one authority once when multiple runtime readers attach and falls back after release', async () => {
    const tracker = new UsageTracker();
    const first = tracker.attachAbsoluteProjection({
      sourceKey: 'journal:project-a',
      getSnapshot: () => Promise.resolve(snapshot({ totalTokens: 12 })),
    });
    const second = tracker.attachAbsoluteProjection({
      sourceKey: 'journal:project-a',
      getSnapshot: () => Promise.resolve(snapshot({ totalTokens: 20 })),
    });

    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 12 });
    first();
    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 20 });
    second();
    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 0 });
  });

  it('rejects an unavailable authoritative projection and exposes its typed status', async () => {
    const tracker = new UsageTracker();
    tracker.attachAbsoluteProjection({
      sourceKey: 'journal:broken',
      getSnapshot: () => Promise.resolve({ mode: 'byok', totalTokens: Number.NaN } as UsageSnapshot),
    });

    await expect(tracker.current()).rejects.toMatchObject({ code: 'PROJECTION_UNAVAILABLE' });
    await expect(tracker.currentAll()).rejects.toMatchObject({ code: 'PROJECTION_UNAVAILABLE' });
    const [status] = await tracker.projectionStatus();
    expect(status?.sourceKey).toBe('journal:broken');
    expect(status?.status).toBe('failed');
    expect(status?.failure?.code).toBe('INVALID_SNAPSHOT');
  });

  it('serializes concurrent direct persistent writers without losing either update', async () => {
    const path = await historyPath();
    const first = new UsageTracker(path);
    const second = new UsageTracker(path);

    await Promise.all([
      first.recordTokens('byok', { promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
      second.recordTokens('byok', { promptTokens: 4, completionTokens: 5, totalTokens: 9 }),
    ]);

    await expect(new UsageTracker(path).current()).resolves.toMatchObject({
      promptTokens: 5, completionTokens: 7, totalTokens: 12,
    });
  });

  it('retains direct totals across modes even after bounded history evicts their old snapshots', async () => {
    const path = await historyPath();
    const tracker = new UsageTracker(path, { historyLimit: 1 });
    await tracker.recordTokens('byok', { promptTokens: 1, completionTokens: 0, totalTokens: 1 });
    for (let index = 0; index < 100; index += 1) {
      await tracker.recordTokens('managed', { promptTokens: 0, completionTokens: 1, totalTokens: 1 });
    }

    await expect(tracker.current('byok')).resolves.toMatchObject({ totalTokens: 1 });
    await expect(tracker.current('managed')).resolves.toMatchObject({ totalTokens: 100 });
    await expect(tracker.directHistory()).resolves.toHaveLength(1);
  });

  it('retains direct totals when history retention is disabled', async () => {
    const tracker = new UsageTracker(await historyPath(), { historyLimit: 0 });
    await tracker.recordTokens('byok', { promptTokens: 2, completionTokens: 3, totalTokens: 5 });

    await expect(tracker.current()).resolves.toMatchObject({ totalTokens: 5 });
    await expect(tracker.directHistory()).resolves.toEqual([]);
  });

  it('rejects a corrupt persisted state rather than guessing a usage balance', async () => {
    const path = await historyPath();
    await saveHistory(path, {
      version: 2,
      directTotals: {
        byok: { mode: 'byok', windowStartedAt: 'not-a-date', promptTokens: -4, completionTokens: 'bad', totalTokens: 3.9 },
      },
      directHistory: [],
    });

    const tracker = new UsageTracker(path);
    await expect(tracker.current()).rejects.toBeInstanceOf(UsageTrackerStateError);
  });

  it('rejects invalid direct-call token records instead of silently recording zero usage', async () => {
    const tracker = new UsageTracker();

    await expect(tracker.recordTokens('byok', {
      promptTokens: -1,
      completionTokens: 0,
      totalTokens: 0,
    })).rejects.toBeInstanceOf(UsageTrackerStateError);
    await expect(tracker.recordTokens('managed', {
      promptTokens: Number.MAX_SAFE_INTEGER + 1,
      completionTokens: 0,
      totalTokens: 0,
    })).rejects.toBeInstanceOf(UsageTrackerStateError);
    await expect(tracker.recordTokens('managed', {
      promptTokens: 1.5,
      completionTokens: 0,
      totalTokens: 0,
    })).rejects.toBeInstanceOf(UsageTrackerStateError);
    await expect(tracker.recordTokens('unknown' as never, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })).rejects.toBeInstanceOf(UsageTrackerStateError);

    await expect(tracker.currentAll()).resolves.toEqual([
      expect.objectContaining({ mode: 'byok', totalTokens: 0 }),
      expect.objectContaining({ mode: 'managed', totalTokens: 0 }),
    ]);
  });

  it('rejects V2 persisted state with unknown keys or billing modes', async () => {
    const path = await historyPath();
    await saveHistory(path, {
      version: 2,
      directTotals: {
        byok: snapshot({ totalTokens: 2 }),
        enterprise: { ...snapshot({ totalTokens: 3 }), mode: 'enterprise' },
      },
      directHistory: [],
      ignored: true,
    });

    await expect(new UsageTracker(path).current()).rejects.toBeInstanceOf(UsageTrackerStateError);
  });

  it('migrates the explicit legacy snapshot history into direct totals', async () => {
    const path = await historyPath();
    await saveHistory(path, [{ ...snapshot({ totalTokens: 7 }), completedRounds: 3 }]);

    await expect(new UsageTracker(path).current()).resolves.toMatchObject({ totalTokens: 7 });
  });

  it('rejects a projection that claims two totals for the same mode', async () => {
    const tracker = new UsageTracker();
    tracker.attachAbsoluteProjection({
      sourceKey: 'journal:duplicate-mode',
      getSnapshot: () => Promise.resolve([snapshot({ totalTokens: 2 }), snapshot({ totalTokens: 3 })]),
    });

    await expect(tracker.current()).rejects.toMatchObject({ code: 'PROJECTION_UNAVAILABLE' });
    const [status] = await tracker.projectionStatus();
    expect(status?.status).toBe('failed');
    expect(status?.failure?.code).toBe('INVALID_SNAPSHOT');
  });
});

function snapshot(tokens: Partial<Pick<UsageSnapshot, 'promptTokens' | 'completionTokens' | 'totalTokens'>>): UsageSnapshot {
  return {
    mode: 'byok',
    windowStartedAt: '2026-06-08T00:00:00.000Z',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...tokens,
  };
}

async function saveHistory(path: string, state: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
