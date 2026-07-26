import { randomUUID } from 'node:crypto';
import { estimateRetainedValueBytes } from './retained-size.js';

export type LlmAsyncJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type LlmAsyncJobItem<T> =
  | { index: number; status: 'completed'; value: T }
  | {
      index: number;
      status: 'failed';
      error: { code: string; message: string; retryable: boolean };
    }
  | {
      index: number;
      status: 'cancelled';
      error: { code: 'LLM_ABORTED'; message: string; retryable: false };
    };

export type LlmAsyncJob<T> = {
  id: string;
  status: LlmAsyncJobStatus;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  items: Array<LlmAsyncJobItem<T>>;
};

type InternalJob<TInput, TOutput> = {
  ownerId: string;
  snapshot: LlmAsyncJob<TOutput>;
  inputs: TInput[];
  controller: AbortController;
  retainedBytes: number;
};

export type LlmAsyncJobRetentionOptions = {
  maxItemBytes?: number;
  maxJobBytes?: number;
  maxTotalBytes?: number;
};

const DEFAULT_MAX_ITEM_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_JOB_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1_024 * 1_024;

export class LlmAsyncJobManager<TInput, TOutput> {
  private readonly jobs = new Map<string, InternalJob<TInput, TOutput>>();
  private readonly maxItemBytes: number;
  private readonly maxJobBytes: number;
  private readonly maxTotalBytes: number;
  private totalRetainedBytes = 0;

  constructor(
    private readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly retentionLimit = 1_000,
    retention: LlmAsyncJobRetentionOptions = {},
  ) {
    positiveInteger(retentionLimit, 'retentionLimit');
    this.maxItemBytes = positiveInteger(
      retention.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES,
      'maxItemBytes',
    );
    this.maxJobBytes = positiveInteger(
      retention.maxJobBytes ?? DEFAULT_MAX_JOB_BYTES,
      'maxJobBytes',
    );
    this.maxTotalBytes = positiveInteger(
      retention.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      'maxTotalBytes',
    );
  }

  submit(
    inputs: TInput[],
    options: { ownerId: string; concurrency?: number },
  ): LlmAsyncJob<TOutput> {
    if (inputs.length === 0) throw new Error('An async LLM job requires at least one item.');
    const ownerId = requireOwnerId(options.ownerId);
    const concurrency = normalizeConcurrency(options.concurrency ?? 4);
    const retainedInputs = cloneInputs(inputs);
    const snapshot: LlmAsyncJob<TOutput> = {
      id: this.createId(),
      status: 'queued',
      total: inputs.length,
      completed: 0,
      failed: 0,
      cancelled: 0,
      createdAt: this.now().toISOString(),
      items: [],
    };
    const job: InternalJob<TInput, TOutput> = {
      ownerId,
      snapshot,
      inputs: retainedInputs,
      controller: new AbortController(),
      retainedBytes: 0,
    };
    this.jobs.set(snapshot.id, job);
    this.evictOldJobs();
    void Promise.resolve().then(async () => this.run(job, concurrency));
    return cloneJob(snapshot);
  }

  get(id: string, ownerId: string): LlmAsyncJob<TOutput> | undefined {
    const requiredOwnerId = requireOwnerId(ownerId);
    const job = this.jobs.get(id);
    return job?.ownerId === requiredOwnerId ? cloneJob(job.snapshot) : undefined;
  }

  cancel(id: string, ownerId: string): LlmAsyncJob<TOutput> | undefined {
    const requiredOwnerId = requireOwnerId(ownerId);
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== requiredOwnerId) return undefined;
    if (
      job.snapshot.status === 'completed' ||
      job.snapshot.status === 'failed' ||
      job.snapshot.status === 'cancelled'
    ) {
      return cloneJob(job.snapshot);
    }
    job.controller.abort();
    return cloneJob(job.snapshot);
  }

  list(ownerId: string): Array<LlmAsyncJob<TOutput>> {
    const requiredOwnerId = requireOwnerId(ownerId);
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === requiredOwnerId)
      .map((job) => cloneJob(job.snapshot))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async run(job: InternalJob<TInput, TOutput>, concurrency: number): Promise<void> {
    job.snapshot.status = 'running';
    job.snapshot.startedAt = this.now().toISOString();
    let cursor = 0;
    const worker = async () => {
      while (cursor < job.inputs.length) {
        const index = cursor;
        cursor += 1;
        const input = job.inputs[index] as TInput;
        if (job.controller.signal.aborted) {
          this.recordCancelled(job, index);
          continue;
        }
        try {
          const value = await this.execute(input, job.controller.signal);
          this.recordCompleted(job, index, value);
        } catch (error) {
          if (job.controller.signal.aborted || errorCode(error) === 'LLM_ABORTED') {
            this.recordCancelled(job, index);
          } else {
            job.snapshot.items.push({
              index,
              status: 'failed',
              error: {
                code: errorCode(error),
                message: error instanceof Error ? error.message : String(error),
                retryable: Boolean(
                  error &&
                  typeof error === 'object' &&
                  'retryable' in error &&
                  (error as { retryable?: unknown }).retryable,
                ),
              },
            });
            job.snapshot.failed += 1;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, job.inputs.length) }, worker));
    job.snapshot.items.sort((left, right) => left.index - right.index);
    job.snapshot.status = job.controller.signal.aborted
      ? 'cancelled'
      : job.snapshot.completed > 0
        ? 'completed'
        : 'failed';
    job.snapshot.finishedAt = this.now().toISOString();
    job.inputs = [];
    this.evictOldJobs();
  }

  private recordCancelled(job: InternalJob<TInput, TOutput>, index: number): void {
    job.snapshot.items.push({
      index,
      status: 'cancelled',
      error: {
        code: 'LLM_ABORTED',
        message: 'Async LLM job item was cancelled.',
        retryable: false,
      },
    });
    job.snapshot.cancelled += 1;
  }

  private recordCompleted(job: InternalJob<TInput, TOutput>, index: number, value: TOutput): void {
    let byteSize: number;
    try {
      byteSize = estimateRetainedValueBytes(value, this.maxItemBytes);
    } catch {
      this.recordRetentionFailure(
        job,
        index,
        'LLM_JOB_RESULT_UNCLONEABLE',
        'Async LLM job result could not be retained safely.',
      );
      return;
    }
    if (byteSize > this.maxItemBytes) {
      this.recordRetentionFailure(
        job,
        index,
        'LLM_JOB_RESULT_TOO_LARGE',
        'Async LLM job result exceeded the per-item retained-byte limit.',
      );
      return;
    }
    if (job.retainedBytes + byteSize > this.maxJobBytes) {
      this.recordRetentionFailure(
        job,
        index,
        'LLM_JOB_RESULT_JOB_LIMIT',
        'Async LLM job result exceeded the per-job retained-byte limit.',
      );
      return;
    }

    let retainedValue: TOutput;
    try {
      retainedValue = structuredClone(value);
    } catch {
      this.recordRetentionFailure(
        job,
        index,
        'LLM_JOB_RESULT_UNCLONEABLE',
        'Async LLM job result could not be retained safely.',
      );
      return;
    }
    this.evictForGlobalCapacity(byteSize, job.snapshot.id);
    if (this.totalRetainedBytes + byteSize > this.maxTotalBytes) {
      this.recordRetentionFailure(
        job,
        index,
        'LLM_JOB_RESULT_GLOBAL_LIMIT',
        'Async LLM job result exceeded the global retained-byte limit.',
      );
      return;
    }

    job.snapshot.items.push({ index, status: 'completed', value: retainedValue });
    job.snapshot.completed += 1;
    job.retainedBytes += byteSize;
    this.totalRetainedBytes += byteSize;
  }

  private recordRetentionFailure(
    job: InternalJob<TInput, TOutput>,
    index: number,
    code:
      | 'LLM_JOB_RESULT_TOO_LARGE'
      | 'LLM_JOB_RESULT_JOB_LIMIT'
      | 'LLM_JOB_RESULT_GLOBAL_LIMIT'
      | 'LLM_JOB_RESULT_UNCLONEABLE',
    message: string,
  ): void {
    job.snapshot.items.push({
      index,
      status: 'failed',
      error: { code, message, retryable: false },
    });
    job.snapshot.failed += 1;
  }

  private evictForGlobalCapacity(byteSize: number, currentJobId: string): void {
    if (this.totalRetainedBytes + byteSize <= this.maxTotalBytes) return;
    const completed = this.terminalJobsOldestFirst(currentJobId);
    while (this.totalRetainedBytes + byteSize > this.maxTotalBytes && completed.length > 0) {
      const oldest = completed.shift();
      if (oldest) this.removeJob(oldest.snapshot.id);
    }
  }

  private evictOldJobs(): void {
    if (this.jobs.size <= this.retentionLimit) return;
    const completed = this.terminalJobsOldestFirst();
    while (this.jobs.size > this.retentionLimit && completed.length > 0) {
      const oldest = completed.shift();
      if (oldest) this.removeJob(oldest.snapshot.id);
    }
  }

  private terminalJobsOldestFirst(excludedJobId?: string): Array<InternalJob<TInput, TOutput>> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.snapshot.id !== excludedJobId &&
          ['completed', 'failed', 'cancelled'].includes(job.snapshot.status),
      )
      .sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt));
  }

  private removeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    this.totalRetainedBytes -= job.retainedBytes;
    return true;
  }
}

function cloneJob<T>(job: LlmAsyncJob<T>): LlmAsyncJob<T> {
  return {
    ...job,
    items: job.items.map((item): LlmAsyncJobItem<T> => {
      if (item.status === 'completed') return { ...item, value: structuredClone(item.value) };
      if (item.status === 'cancelled') return { ...item, error: { ...item.error } };
      return { ...item, error: { ...item.error } };
    }),
  };
}

function normalizeConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new Error('concurrency must be between 1 and 100.');
  return value;
}

function errorCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'LLM_JOB_ITEM_FAILED';
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requireOwnerId(ownerId: string): string {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new Error('ownerId is required for async LLM job isolation.');
  }
  return ownerId;
}

function cloneInputs<T>(inputs: T[]): T[] {
  try {
    return structuredClone(inputs);
  } catch {
    throw new TypeError('Async LLM job inputs must be structured-cloneable.');
  }
}
