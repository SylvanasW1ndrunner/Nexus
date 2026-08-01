import { randomUUID } from 'node:crypto';
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentSubagentRecord,
  AgentSubagentRunner,
  AgentSubagentStore,
  SpawnAgentSubagentInput,
} from './types.js';

const RESTART_INTERRUPTION_MESSAGE = 'Child Agent was interrupted by a runtime restart.';

export class AgentSubagentPool {
  private readonly records = new Map<string, AgentSubagentRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly parentSignalCleanups = new Map<string, () => void>();

  constructor(
    private readonly runner: AgentSubagentRunner,
    private readonly options: {
      maxConcurrent?: number;
      maxDepth?: number;
      now?: () => string;
      createId?: () => string;
      store?: AgentSubagentStore;
      steer?: (childSessionId: string, message: string) => boolean;
    } = {},
  ) {
    this.restorePersistedRecords();
  }

  spawn(input: SpawnAgentSubagentInput): Promise<AgentSubagentRecord> {
    return Promise.resolve().then(() => {
      const running = [...this.records.values()].filter(
        (record) => record.status === 'running',
      ).length;
      const maxConcurrent = this.options.maxConcurrent ?? 3;
      if (running >= maxConcurrent) {
        throw new Error(`Subagent concurrency limit reached: ${maxConcurrent}.`);
      }
      const depth = input.depth ?? 1;
      const maxDepth = this.options.maxDepth ?? 1;
      if (depth > maxDepth) {
        throw new Error(`Subagent depth limit reached: ${maxDepth}.`);
      }
      const id = this.options.createId?.() ?? randomUUID();
      if (this.records.has(id)) {
        throw new Error(`Subagent id already exists: ${id}.`);
      }
      const controller = new AbortController();
      const createdAt = this.now();
      const parentSignal = input.options.signal;
      const record: AgentSubagentRecord = {
        id,
        parentSessionId: requireText(input.parentSessionId, 'parentSessionId'),
        task: requireText(input.task, 'task'),
        contextStrategy: input.contextStrategy ?? 'fresh',
        status: parentSignal?.aborted ? 'cancelled' : 'running',
        ...(input.options.initialSession === undefined
          ? {}
          : { childSessionId: input.options.initialSession.id }),
        depth,
        createdAt,
        updatedAt: createdAt,
      };
      this.setRecord(record);
      if (record.status === 'cancelled') return structuredClone(record);

      this.controllers.set(id, controller);
      if (parentSignal) {
        const onParentAbort = () => {
          try {
            this.cancel(id, parentSignal.reason);
          } catch (error) {
            const cancelled = this.records.get(id);
            if (cancelled?.status === 'cancelled') {
              this.records.set(id, {
                ...cancelled,
                errorMessage: `Failed to persist cancellation: ${errorMessage(error)}`,
              });
            }
          }
        };
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        this.parentSignalCleanups.set(id, () => {
          parentSignal.removeEventListener('abort', onParentAbort);
        });
        if (parentSignal.aborted) onParentAbort();
      }
      if (this.records.get(id)?.status === 'running') {
        const execution = this.execute(id, input.options, controller.signal);
        this.executions.set(id, execution);
        void execution.finally(() => this.executions.delete(id));
      }
      return structuredClone(this.records.get(id) ?? record);
    });
  }

  get(id: string): AgentSubagentRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  list(parentSessionId?: string): AgentSubagentRecord[] {
    return [...this.records.values()]
      .filter(
        (record) => parentSessionId === undefined || record.parentSessionId === parentSessionId,
      )
      .map((record) => structuredClone(record));
  }

  async wait(id: string, timeoutMs = 60_000): Promise<AgentSubagentRecord> {
    const deadline = Date.now() + positiveInteger(timeoutMs, 'timeoutMs');
    while (true) {
      const record = this.records.get(id);
      if (!record) throw new Error(`Subagent not found: ${id}.`);
      if (record.status !== 'running' && !this.executions.has(id)) {
        return structuredClone(record);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for subagent ${id}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  stop(id: string): boolean {
    return this.cancel(id);
  }

  message(id: string, message: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'running' || !record.childSessionId) return false;
    const steer = this.options.steer;
    if (!steer) return false;
    return steer(record.childSessionId, requireText(message, 'message'));
  }

  private cancel(id: string, reason?: unknown): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'running') return false;
    const cancelled: AgentSubagentRecord = {
      ...record,
      status: 'cancelled',
      updatedAt: this.now(),
    };
    // Cancellation is the safety boundary: update memory and signal the child
    // before a durable write can fail or block the propagation path.
    this.records.set(id, structuredClone(cancelled));
    this.controllers.get(id)?.abort(reason);
    this.cleanupParentSignal(id);
    this.options.store?.saveSubagent(cancelled);
    return true;
  }

  private async execute(id: string, options: AgentRunOptions, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.runner({ ...options, signal });
      const current = this.records.get(id);
      if (!current || current.status === 'cancelled') return;
      this.setRecord(completedRecord(current, result, this.now()));
    } catch (error) {
      const current = this.records.get(id);
      if (!current || current.status === 'cancelled') return;
      this.setRecord({
        ...current,
        status: signal.aborted ? 'cancelled' : 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: this.now(),
      });
    } finally {
      this.controllers.delete(id);
      this.cleanupParentSignal(id);
    }
  }

  private restorePersistedRecords(): void {
    for (const persisted of this.options.store?.listSubagents() ?? []) {
      const record =
        persisted.status === 'running'
          ? {
              ...persisted,
              status: 'failed' as const,
              errorMessage: RESTART_INTERRUPTION_MESSAGE,
              updatedAt: this.now(),
            }
          : persisted;
      if (persisted.status === 'running') this.options.store?.saveSubagent(record);
      this.records.set(record.id, structuredClone(record));
    }
  }

  private setRecord(record: AgentSubagentRecord): void {
    this.options.store?.saveSubagent(record);
    this.records.set(record.id, structuredClone(record));
  }

  private cleanupParentSignal(id: string): void {
    this.parentSignalCleanups.get(id)?.();
    this.parentSignalCleanups.delete(id);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function completedRecord(
  record: AgentSubagentRecord,
  result: AgentRunResult,
  now: string,
): AgentSubagentRecord {
  const status =
    result.status === 'done' ? 'completed' : result.status === 'aborted' ? 'cancelled' : 'failed';
  const artifactReferences = result.artifacts?.map((artifact) => artifact.path) ?? [];
  return {
    ...record,
    status,
    childSessionId: result.session.id,
    summary: result.finalText,
    ...(artifactReferences.length === 0 ? {} : { artifactReferences }),
    ...(status === 'failed'
      ? { errorMessage: `Child Agent finished with status ${result.status}.` }
      : {}),
    updatedAt: now,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
