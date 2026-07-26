/* eslint-disable @typescript-eslint/require-await -- Executor test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import { LlmAsyncJobManager, type LlmAsyncJob } from '../src/index.js';

const TEST_OWNER = 'tenant-a';

describe('LlmAsyncJobManager retained-result safety', () => {
  it('deep-clones completed values when retaining and returning job snapshots', async () => {
    const source = {
      nested: {
        values: ['original'],
      },
    };
    const manager = managerWithLimits(async () => source);
    const submitted = manager.submit([1], { ownerId: TEST_OWNER, concurrency: 1 });
    const completed = await waitForJob(manager, submitted.id);

    source.nested.values.push('source mutation');
    const firstRead = manager.get(submitted.id, TEST_OWNER);
    expect(completed.items).toEqual([
      {
        index: 0,
        status: 'completed',
        value: { nested: { values: ['original'] } },
      },
    ]);
    expect(firstRead?.items).toEqual(completed.items);

    const completedItem = firstRead?.items[0];
    if (completedItem?.status !== 'completed') throw new Error('Expected a completed item.');
    completedItem.value.nested.values.push('snapshot mutation');

    expect(manager.get(submitted.id, TEST_OWNER)?.items).toEqual(completed.items);
  });

  it('records a stable failure instead of retaining an oversized item result', async () => {
    const manager = managerWithLimits(async () => ({ payload: 'x'.repeat(512) }), {
      maxItemBytes: 128,
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
    });
    const submitted = manager.submit([1], { ownerId: TEST_OWNER, concurrency: 1 });

    const completed = await waitForJob(manager, submitted.id);

    expect(completed).toMatchObject({
      status: 'failed',
      completed: 0,
      failed: 1,
      items: [
        {
          index: 0,
          status: 'failed',
          error: {
            code: 'LLM_JOB_RESULT_TOO_LARGE',
            retryable: false,
          },
        },
      ],
    });
    expect(JSON.stringify(completed)).not.toContain('x'.repeat(128));
  });

  it('enforces a per-job retained-byte budget without discarding earlier results', async () => {
    const manager = managerWithLimits(
      async (input: number) => ({ payload: String(input).repeat(140) }),
      {
        maxItemBytes: 512,
        maxJobBytes: 300,
        maxTotalBytes: 2_048,
      },
    );
    const submitted = manager.submit([1, 2], { ownerId: TEST_OWNER, concurrency: 1 });

    const completed = await waitForJob(manager, submitted.id);

    expect(completed.completed).toBe(1);
    expect(completed.failed).toBe(1);
    expect(completed.items[0]).toMatchObject({ index: 0, status: 'completed' });
    expect(completed.items[1]).toMatchObject({
      index: 1,
      status: 'failed',
      error: {
        code: 'LLM_JOB_RESULT_JOB_LIMIT',
        retryable: false,
      },
    });
  });

  it('uses a stable global-limit failure when active results consume the retained-byte budget', async () => {
    const manager = managerWithLimits(
      async (input: number) => ({ payload: String(input).repeat(140) }),
      {
        maxItemBytes: 512,
        maxJobBytes: 2_048,
        maxTotalBytes: 300,
      },
    );
    const submitted = manager.submit([1, 2], { ownerId: TEST_OWNER, concurrency: 1 });

    const completed = await waitForJob(manager, submitted.id);

    expect(completed.completed).toBe(1);
    expect(completed.failed).toBe(1);
    expect(completed.items[1]).toMatchObject({
      index: 1,
      status: 'failed',
      error: {
        code: 'LLM_JOB_RESULT_GLOBAL_LIMIT',
        retryable: false,
      },
    });
  });

  it('evicts the oldest terminal job before retaining a newer job under the global budget', async () => {
    let nextId = 0;
    let tick = 0;
    const manager = new LlmAsyncJobManager(
      async (input: string) => ({ payload: input.repeat(140) }),
      () => new Date(tick++ * 1_000),
      () => `job-${++nextId}`,
      100,
      {
        maxItemBytes: 512,
        maxJobBytes: 512,
        maxTotalBytes: 300,
      },
    );
    const first = manager.submit(['a'], { ownerId: TEST_OWNER, concurrency: 1 });
    await waitForJob(manager, first.id);
    const second = manager.submit(['b'], { ownerId: TEST_OWNER, concurrency: 1 });

    const completed = await waitForJob(manager, second.id);

    expect(manager.get(first.id, TEST_OWNER)).toBeUndefined();
    expect(completed.items[0]).toMatchObject({
      status: 'completed',
      value: { payload: 'b'.repeat(140) },
    });
  });

  it('does not reveal, list, or cancel jobs across owners', async () => {
    let release: (() => void) | undefined;
    const manager = managerWithLimits(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve('private');
        }),
    );
    const submitted = manager.submit([1], { ownerId: TEST_OWNER, concurrency: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.get(submitted.id, 'tenant-b')).toBeUndefined();
    expect(manager.cancel(submitted.id, 'tenant-b')).toBeUndefined();
    expect(manager.list('tenant-b')).toEqual([]);
    expect(manager.list(TEST_OWNER)).toHaveLength(1);

    release?.();
    await waitForJob(manager, submitted.id);
  });

  it('snapshots inputs before asynchronous execution to prevent caller mutation', async () => {
    const source = { prompt: 'original' };
    const manager = managerWithLimits(async (input: { prompt: string }) => input.prompt);
    const submitted = manager.submit([source], { ownerId: TEST_OWNER, concurrency: 1 });

    source.prompt = 'mutated after submission';
    const completed = await waitForJob(manager, submitted.id);

    expect(completed.items).toEqual([{ index: 0, status: 'completed', value: 'original' }]);
  });

  it('enforces the retention limit after concurrently submitted jobs become terminal', async () => {
    let nextId = 0;
    const manager = new LlmAsyncJobManager(
      async (input: number) => input,
      () => new Date(),
      () => `retention-job-${++nextId}`,
      2,
    );

    manager.submit([1], { ownerId: TEST_OWNER });
    manager.submit([2], { ownerId: TEST_OWNER });
    const last = manager.submit([3], { ownerId: TEST_OWNER });
    await waitForJob(manager, last.id);

    expect(manager.list(TEST_OWNER)).toHaveLength(2);
  });
});

type RetentionLimits = {
  maxItemBytes: number;
  maxJobBytes: number;
  maxTotalBytes: number;
};

function managerWithLimits<TInput, TOutput>(
  execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>,
  limits: RetentionLimits = {
    maxItemBytes: 1_024,
    maxJobBytes: 4_096,
    maxTotalBytes: 8_192,
  },
): LlmAsyncJobManager<TInput, TOutput> {
  return new LlmAsyncJobManager(
    execute,
    () => new Date(),
    () => 'job-1',
    100,
    limits,
  );
}

async function waitForJob<TInput, TOutput>(
  manager: LlmAsyncJobManager<TInput, TOutput>,
  id: string,
): Promise<LlmAsyncJob<TOutput>> {
  for (let index = 0; index < 100; index += 1) {
    const job = manager.get(id, TEST_OWNER);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Async job did not reach a terminal state.');
}
