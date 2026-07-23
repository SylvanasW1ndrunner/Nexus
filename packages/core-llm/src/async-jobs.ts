import { randomUUID } from 'node:crypto';

export type LlmAsyncJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type LlmAsyncJobItem<T> =
  | { index: number; status: 'completed'; value: T }
  | { index: number; status: 'failed'; error: { code: string; message: string; retryable: boolean } }
  | { index: number; status: 'cancelled'; error: { code: 'LLM_ABORTED'; message: string; retryable: false } };

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
  snapshot: LlmAsyncJob<TOutput>;
  inputs: TInput[];
  controller: AbortController;
};

export class LlmAsyncJobManager<TInput, TOutput> {
  private readonly jobs = new Map<string, InternalJob<TInput, TOutput>>();

  constructor(
    private readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly retentionLimit = 1_000,
  ) {}

  submit(inputs: TInput[], options: { concurrency?: number } = {}): LlmAsyncJob<TOutput> {
    if (inputs.length === 0) throw new Error('An async LLM job requires at least one item.');
    const concurrency = normalizeConcurrency(options.concurrency ?? 4);
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
      snapshot,
      inputs: [...inputs],
      controller: new AbortController(),
    };
    this.jobs.set(snapshot.id, job);
    this.evictOldJobs();
    void Promise.resolve().then(async () => this.run(job, concurrency));
    return cloneJob(snapshot);
  }

  get(id: string): LlmAsyncJob<TOutput> | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job.snapshot) : undefined;
  }

  cancel(id: string): LlmAsyncJob<TOutput> | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.snapshot.status === 'completed' || job.snapshot.status === 'failed' || job.snapshot.status === 'cancelled') {
      return cloneJob(job.snapshot);
    }
    job.controller.abort();
    return cloneJob(job.snapshot);
  }

  list(): Array<LlmAsyncJob<TOutput>> {
    return [...this.jobs.values()]
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
          job.snapshot.items.push({ index, status: 'completed', value });
          job.snapshot.completed += 1;
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
                  error && typeof error === 'object' && 'retryable' in error && (error as { retryable?: unknown }).retryable,
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
  }

  private recordCancelled(job: InternalJob<TInput, TOutput>, index: number): void {
    job.snapshot.items.push({
      index,
      status: 'cancelled',
      error: { code: 'LLM_ABORTED', message: 'Async LLM job item was cancelled.', retryable: false },
    });
    job.snapshot.cancelled += 1;
  }

  private evictOldJobs(): void {
    if (this.jobs.size <= this.retentionLimit) return;
    const completed = [...this.jobs.values()]
      .filter((job) => ['completed', 'failed', 'cancelled'].includes(job.snapshot.status))
      .sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt));
    while (this.jobs.size > this.retentionLimit && completed.length > 0) {
      const oldest = completed.shift();
      if (oldest) this.jobs.delete(oldest.snapshot.id);
    }
  }
}

function cloneJob<T>(job: LlmAsyncJob<T>): LlmAsyncJob<T> {
  return {
    ...job,
    items: job.items.map((item): LlmAsyncJobItem<T> => {
      if (item.status === 'completed') return { ...item };
      if (item.status === 'cancelled') return { ...item, error: { ...item.error } };
      return { ...item, error: { ...item.error } };
    }),
  };
}

function normalizeConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('concurrency must be between 1 and 100.');
  return value;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'LLM_JOB_ITEM_FAILED';
}
