import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '@dbagent/shared';
import { UsageTracker } from '../src/usage-tracker.js';

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
  it('returns a BYOK zero-use snapshot when history is missing', async () => {
    const current = await new UsageTracker(await historyPath()).current();

    expect(current).toMatchObject({
      mode: 'byok',
      usedRounds: 0,
      byokTokenEstimate: 0,
    });
    expect(Date.parse(current.windowStartedAt)).not.toBeNaN();
  });

  it('reads history newest-first and respects the requested limit', async () => {
    const path = await historyPath();
    await saveHistory(path, [snapshot(3), snapshot(2), snapshot(1)]);

    await expect(new UsageTracker(path).history(2)).resolves.toEqual([snapshot(3), snapshot(2)]);
  });

  it('increments the current local query count and prepends it to history', async () => {
    const path = await historyPath();
    await saveHistory(path, [snapshot(5), snapshot(4)]);

    const tracker = new UsageTracker(path);
    await expect(tracker.recordLocalQuery()).resolves.toEqual(snapshot(6));
    await expect(tracker.history()).resolves.toEqual([snapshot(6), snapshot(5), snapshot(4)]);
  });

  it('caps retained history at one hundred snapshots', async () => {
    const path = await historyPath();
    await saveHistory(
      path,
      Array.from({ length: 100 }, (_, index) => snapshot(100 - index)),
    );

    const tracker = new UsageTracker(path);
    const history = await tracker.recordLocalQuery().then(() => tracker.history(200));

    expect(history).toHaveLength(100);
    expect(history[0]).toEqual(snapshot(101));
    expect(history.at(-1)).toEqual(snapshot(2));
  });
});

function snapshot(usedRounds: number): UsageSnapshot {
  return {
    mode: 'byok',
    windowStartedAt: '2026-06-08T00:00:00.000Z',
    usedRounds,
    byokTokenEstimate: 0,
  };
}

async function saveHistory(path: string, history: UsageSnapshot[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}
