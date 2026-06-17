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

  it('records BYOK token estimates without incrementing conversation rounds', async () => {
    const path = await historyPath();
    await saveHistory(path, [snapshot(5)]);

    const tracker = new UsageTracker(path);
    await expect(tracker.recordByokTokens(37.8)).resolves.toEqual({
      ...snapshot(5),
      byokTokenEstimate: 37,
    });
    await expect(tracker.recordByokTokens(-10)).resolves.toEqual({
      ...snapshot(5),
      byokTokenEstimate: 37,
    });
  });

  it('tracks a successful Agent round with token usage and persistent round history', async () => {
    const path = await historyPath();
    const tracker = new UsageTracker(path, fixedUsageOptions());

    const round = await tracker.startConversationRound('session_orders', 'byok');
    await tracker.recordLlmCall(round, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    await tracker.recordLlmCall(round, { promptTokens: 20, completionTokens: 8, totalTokens: 28 });
    await expect(tracker.endConversationRound(round, 'success')).resolves.toMatchObject({
      mode: 'byok',
      usedRounds: 1,
      byokTokenEstimate: 43,
    });

    await expect(tracker.roundHistory()).resolves.toMatchObject([
      {
        id: 'round_1',
        sessionId: 'session_orders',
        mode: 'byok',
        status: 'success',
        promptTokens: 30,
        completionTokens: 13,
        totalTokens: 43,
      },
    ]);
  });

  it('counts user-aborted rounds but does not count system-failed rounds', async () => {
    const path = await historyPath();
    const tracker = new UsageTracker(path, fixedUsageOptions());

    const aborted = await tracker.startConversationRound('session_abort', 'byok');
    await tracker.endConversationRound(aborted, 'aborted');
    const failed = await tracker.startConversationRound('session_failed', 'byok');
    await tracker.endConversationRound(failed, 'failed', 'provider timeout');

    await expect(tracker.current()).resolves.toMatchObject({
      usedRounds: 1,
    });
    await expect(tracker.roundHistory()).resolves.toMatchObject([
      { sessionId: 'session_failed', status: 'failed', errorMessage: 'provider timeout' },
      { sessionId: 'session_abort', status: 'aborted' },
    ]);
  });

  it('reports subscription quota status from completed billable rounds', async () => {
    const path = await historyPath();
    const tracker = new UsageTracker(path, { ...fixedUsageOptions(), subscriptionRoundLimit: 1 });

    await expect(tracker.getCurrentQuota('subscription')).resolves.toMatchObject({
      mode: 'subscription',
      roundsUsed: 0,
      roundLimit: 1,
      remainingRounds: 1,
      exceeded: false,
    });

    const round = await tracker.startConversationRound('session_subscription', 'subscription');
    await tracker.endConversationRound(round, 'success');

    await expect(tracker.getCurrentQuota('subscription')).resolves.toMatchObject({
      mode: 'subscription',
      roundsUsed: 1,
      roundLimit: 1,
      remainingRounds: 0,
      exceeded: true,
    });
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

function fixedUsageOptions() {
  let nextId = 0;
  return {
    now: () => new Date('2026-06-17T00:00:00.000Z'),
    createRoundId: () => `round_${++nextId}`,
  };
}
