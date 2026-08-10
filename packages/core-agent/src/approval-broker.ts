import { redactPersistedAgentValue } from './redaction.js';
import type { ToolApprovalFact } from './events/agent-event.js';
import type { AgentJournal, ToolApprovalPage } from './events/agent-journal.js';
import type {
  ToolApprovalDecision,
  ToolInvocationRuntime,
} from './tools/tool-invocation-runtime.js';
import type { ToolScheduleDecision } from './tools/tool-scheduler.js';
import type {
  AgentMode,
  ApprovalProvider,
  ApprovalProviderResult,
  PermissionRequest,
  ToolDangerLevel,
} from './types.js';

export type AgentToolApprovalRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

export type AgentToolApprovalRequest = {
  id: string;
  status: AgentToolApprovalRequestStatus;
  mode: AgentMode;
  sessionId?: string;
  sessionTitle?: string;
  toolCallId: string;
  toolName: string;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  toolSource?: string;
  toolSourceId?: string;
  argumentPreview: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
};

export type AgentToolApprovalResolution = {
  approved: boolean;
  resolvedBy?: string;
  reason?: string;
};

export type JournalApprovalBrokerOptions = Readonly<{
  journal: AgentJournal;
  runtime: Pick<ToolInvocationRuntime, 'decideApproval'>;
  binding: Readonly<{ projectId: string; sessionId: string; runId: string }>;
  pollIntervalMs?: number;
}>;

export type ApprovalPageInput = Readonly<{
  cursor?: string;
  limit: number;
}>;

export class JournalApprovalWaitError extends Error {
  constructor(
    readonly code:
      | 'APPROVAL_NOT_FOUND'
      | 'APPROVAL_WAIT_ABORTED'
      | 'APPROVAL_BINDING_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'JournalApprovalWaitError';
  }
}

/**
 * Journal-backed approval query/decision boundary for the unified Runtime.
 * It owns no approval facts: restart, list, repeated decisions and conflicts
 * are always answered by the Agent Journal and ToolInvocationRuntime.
 */
export class JournalApprovalBroker {
  readonly #journal: AgentJournal;
  readonly #runtime: Pick<ToolInvocationRuntime, 'decideApproval'>;
  readonly #binding: Readonly<{ projectId: string; sessionId: string; runId: string }>;
  readonly #pollIntervalMs: number;

  constructor(options: JournalApprovalBrokerOptions) {
    this.#journal = options.journal;
    this.#runtime = options.runtime;
    this.#binding = Object.freeze({ ...options.binding });
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
    if (
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 1 ||
      this.#pollIntervalMs > 60_000
    ) {
      throw new TypeError('pollIntervalMs must be an integer between 1 and 60000.');
    }
  }

  async listPending(page: ApprovalPageInput): Promise<ToolApprovalPage> {
    return await this.#journal.listApprovals({
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      limit: page.limit,
      status: 'pending',
    });
  }

  async listAll(page: ApprovalPageInput): Promise<ToolApprovalPage> {
    return await this.#journal.listApprovals({
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      limit: page.limit,
    });
  }

  async get(invocationId: string): Promise<ToolApprovalFact | null> {
    return await this.#journal.getApproval({
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
      invocationId,
    });
  }

  async decide(decision: ToolApprovalDecision): Promise<ToolScheduleDecision> {
    if (
      decision.projectId !== this.#binding.projectId ||
      decision.sessionId !== this.#binding.sessionId ||
      decision.runId !== this.#binding.runId
    ) {
      throw new JournalApprovalWaitError(
        'APPROVAL_BINDING_MISMATCH',
        'The approval decision is outside this broker binding.',
      );
    }
    return await this.#runtime.decideApproval(decision);
  }

  async waitForDecision(
    invocationId: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ToolApprovalFact> {
    for (;;) {
      if (options.signal?.aborted) {
        throw new JournalApprovalWaitError(
          'APPROVAL_WAIT_ABORTED',
          'Waiting for the approval decision was aborted.',
        );
      }
      const approval = await this.#journal.getApproval({
        projectId: this.#binding.projectId,
        sessionId: this.#binding.sessionId,
        runId: this.#binding.runId,
        invocationId,
      });
      if (approval === null) {
        throw new JournalApprovalWaitError(
          'APPROVAL_NOT_FOUND',
          'The Journal contains no approval for this Invocation.',
        );
      }
      if (approval.status !== 'pending') return approval;
      await waitForJournalChange(this.#pollIntervalMs, options.signal);
    }
  }
}

export type AgentToolApprovalBrokerOptions = {
  now?: () => string;
  createRequestId?: () => string;
  approvalTimeoutMs?: number;
  maxArgumentPreviewChars?: number;
  /** Receives the same redacted request retained by the legacy compatibility path. */
  onRequest?: (request: AgentToolApprovalRequest) => void;
};

type ApprovalWaiter = {
  resolve: (result: ApprovalProviderResult) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;
  signal: AbortSignal | undefined;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_ARGUMENT_PREVIEW_CHARS = 2_000;

/**
 * @deprecated Compatibility-only broker for the still-public legacy
 * SDK/React path. It preserves that path until Task 9/11 performs the atomic
 * cutover and deletes it. Unified ToolInvocationRuntime never consumes this
 * in-memory projection; its sole durable truth is JournalApprovalBroker.
 */
export class AgentToolApprovalBroker {
  readonly #legacyRequests = new Map<string, AgentToolApprovalRequest>();
  readonly #waiters = new Map<string, ApprovalWaiter>();
  readonly #now: () => string;
  readonly #createRequestId: () => string;
  readonly #approvalTimeoutMs: number;
  readonly #maxArgumentPreviewChars: number;
  readonly #onRequest: ((request: AgentToolApprovalRequest) => void) | undefined;
  #fallbackRequestId = 0;

  constructor(options: AgentToolApprovalBrokerOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createRequestId = options.createRequestId ?? (() => this.#defaultRequestId());
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#maxArgumentPreviewChars =
      options.maxArgumentPreviewChars ?? DEFAULT_MAX_ARGUMENT_PREVIEW_CHARS;
    this.#onRequest = options.onRequest;
  }

  createProvider(): ApprovalProvider {
    return (request) => this.requestApproval(request);
  }

  requestApproval(request: PermissionRequest): Promise<ApprovalProviderResult> {
    const transient = this.#createTransientRequest(request);
    this.#legacyRequests.set(transient.id, transient);
    if (request.signal?.aborted) {
      this.#finish(transient.id, {
        approved: false,
        reason: 'aborted before approval request was created',
      }, 'cancelled');
      return Promise.resolve({ approved: false, requestId: transient.id,
        reason: 'aborted before approval request was created' });
    }
    return new Promise<ApprovalProviderResult>((resolve, reject) => {
      const timeout = this.#approvalTimeoutMs <= 0
        ? undefined
        : setTimeout(() => this.#finish(transient.id, {
          approved: false, reason: 'approval request expired',
        }, 'expired'), this.#approvalTimeoutMs);
      const onAbort = request.signal === undefined
        ? undefined
        : () => this.#finish(transient.id, {
          approved: false, reason: 'approval request was cancelled',
        }, 'cancelled');
      if (request.signal !== undefined && onAbort !== undefined) {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.set(transient.id, {
        resolve,
        timeout,
        onAbort,
        signal: request.signal,
      });
      try {
        this.#onRequest?.(cloneApprovalRequest(transient));
      } catch (error) {
        const waiter = this.#waiters.get(transient.id);
        this.#waiters.delete(transient.id);
        this.#legacyRequests.delete(transient.id);
        if (waiter?.timeout !== undefined) clearTimeout(waiter.timeout);
        if (request.signal !== undefined && onAbort !== undefined) {
          request.signal.removeEventListener('abort', onAbort);
        }
        reject(error instanceof Error
          ? error
          : new Error('Approval request callback failed.', { cause: error }));
      }
    });
  }

  listPending(): AgentToolApprovalRequest[] {
    return [...this.#legacyRequests.values()]
      .filter(({ status }) => status === 'pending')
      .map(cloneApprovalRequest);
  }

  listAll(): AgentToolApprovalRequest[] {
    return [...this.#legacyRequests.values()].map(cloneApprovalRequest);
  }

  getRequest(id: string): AgentToolApprovalRequest | undefined {
    const request = this.#legacyRequests.get(id);
    return request === undefined ? undefined : cloneApprovalRequest(request);
  }

  approve(id: string, options: Omit<AgentToolApprovalResolution, 'approved'> = {}): boolean {
    return this.#finish(id, { ...options, approved: true }, 'approved');
  }

  deny(id: string, options: Omit<AgentToolApprovalResolution, 'approved'> = {}): boolean {
    return this.#finish(id, { ...options, approved: false }, 'denied');
  }

  cancel(id: string, reason = 'approval request was cancelled'): boolean {
    return this.#finish(id, { approved: false, reason }, 'cancelled');
  }

  cancelSession(
    sessionId: string,
    reason = 'approval request was superseded by new user input',
  ): number {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return 0;
    let cancelled = 0;
    for (const request of this.#legacyRequests.values()) {
      if (
        request.status === 'pending' && request.sessionId === normalized &&
        this.cancel(request.id, reason)
      ) cancelled += 1;
    }
    return cancelled;
  }

  #createTransientRequest(request: PermissionRequest): AgentToolApprovalRequest {
    const createdAt = this.#now();
    return {
      id: this.#createRequestId(),
      status: 'pending',
      mode: request.mode,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.sessionTitle === undefined ? {} : { sessionTitle: request.sessionTitle }),
      toolCallId: request.toolCall.id,
      toolName: request.tool.name,
      dangerLevel: request.tool.dangerLevel,
      readonly: request.tool.readonly === true,
      ...(request.tool.source === undefined ? {} : { toolSource: request.tool.source }),
      ...(request.tool.sourceId === undefined ? {} : { toolSourceId: request.tool.sourceId }),
      argumentPreview: previewArguments(request.toolCall.arguments, this.#maxArgumentPreviewChars),
      createdAt,
      updatedAt: createdAt,
    };
  }

  #finish(
    id: string,
    resolution: AgentToolApprovalResolution,
    status: Exclude<AgentToolApprovalRequestStatus, 'pending'>,
  ): boolean {
    const request = this.#legacyRequests.get(id);
    const waiter = this.#waiters.get(id);
    if (request === undefined || request.status !== 'pending') return false;
    this.#waiters.delete(id);
    if (waiter?.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter?.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    const resolvedAt = this.#now();
    this.#legacyRequests.set(id, {
      ...request,
      status,
      updatedAt: resolvedAt,
      resolvedAt,
      ...(resolution.resolvedBy === undefined ? {} : { resolvedBy: resolution.resolvedBy }),
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    });
    waiter?.resolve({
      approved: resolution.approved,
      requestId: id,
      ...(resolution.approved ? { approvedAt: resolvedAt } : {}),
      ...(resolution.resolvedBy === undefined ? {} : { approvedBy: resolution.resolvedBy }),
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    });
    return true;
  }

  #defaultRequestId(): string {
    if (globalThis.crypto?.randomUUID) return `approval_${globalThis.crypto.randomUUID()}`;
    this.#fallbackRequestId += 1;
    return `approval_${this.#fallbackRequestId}`;
  }
}

async function waitForJournalChange(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new JournalApprovalWaitError(
      'APPROVAL_WAIT_ABORTED',
      'Waiting for the approval decision was aborted.',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new JournalApprovalWaitError(
        'APPROVAL_WAIT_ABORTED',
        'Waiting for the approval decision was aborted.',
      ));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function previewArguments(args: Record<string, unknown>, maxChars: number): string {
  const serialized = safeStringify(redactPersistedAgentValue(args));
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key: string, child: unknown): unknown => {
    if (!child || typeof child !== 'object') return child;
    if (seen.has(child)) return '[Circular]';
    seen.add(child);
    return child;
  });
  return serialized ?? 'undefined';
}

function cloneApprovalRequest(request: AgentToolApprovalRequest): AgentToolApprovalRequest {
  return { ...request };
}
