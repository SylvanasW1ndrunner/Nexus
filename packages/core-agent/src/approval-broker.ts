import { redactPersistedAgentValue } from './redaction.js';
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

export type AgentToolApprovalBrokerOptions = {
  now?: () => string;
  createRequestId?: () => string;
  approvalTimeoutMs?: number;
  maxArgumentPreviewChars?: number;
};

type PendingApproval = {
  resolve: (result: ApprovalProviderResult) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;
  signal: AbortSignal | undefined;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_ARGUMENT_PREVIEW_CHARS = 2_000;

export class AgentToolApprovalBroker {
  private readonly requests = new Map<string, AgentToolApprovalRequest>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly now: () => string;
  private readonly createRequestId: () => string;
  private readonly approvalTimeoutMs: number;
  private readonly maxArgumentPreviewChars: number;
  private fallbackRequestId = 0;

  constructor(options: AgentToolApprovalBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createRequestId = options.createRequestId ?? (() => this.defaultRequestId());
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.maxArgumentPreviewChars =
      options.maxArgumentPreviewChars ?? DEFAULT_MAX_ARGUMENT_PREVIEW_CHARS;
  }

  createProvider(): ApprovalProvider {
    return (request) => this.requestApproval(request);
  }

  requestApproval(request: PermissionRequest): Promise<ApprovalProviderResult> {
    const approvalRequest = this.createApprovalRequest(request);
    this.requests.set(approvalRequest.id, approvalRequest);

    if (request.signal?.aborted) {
      this.finish(approvalRequest.id, 'cancelled', {
        approved: false,
        reason: 'aborted before approval request was created',
      });
      return Promise.resolve({
        approved: false,
        requestId: approvalRequest.id,
        reason: 'aborted before approval request was created',
      });
    }

    return new Promise<ApprovalProviderResult>((resolve) => {
      const timeout =
        this.approvalTimeoutMs <= 0
          ? undefined
          : setTimeout(() => {
              this.finish(approvalRequest.id, 'expired', {
                approved: false,
                reason: 'approval request expired',
              });
            }, this.approvalTimeoutMs);
      const onAbort = request.signal
        ? () => {
            this.finish(approvalRequest.id, 'cancelled', {
              approved: false,
              reason: 'approval request was cancelled',
            });
          }
        : undefined;

      if (request.signal && onAbort)
        request.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(approvalRequest.id, {
        resolve,
        timeout,
        onAbort,
        signal: request.signal,
      });
    });
  }

  listPending(): AgentToolApprovalRequest[] {
    return this.listByStatus('pending');
  }

  listAll(): AgentToolApprovalRequest[] {
    return [...this.requests.values()].map(cloneApprovalRequest);
  }

  getRequest(id: string): AgentToolApprovalRequest | undefined {
    const request = this.requests.get(id);
    return request === undefined ? undefined : cloneApprovalRequest(request);
  }

  approve(id: string, options: Omit<AgentToolApprovalResolution, 'approved'> = {}): boolean {
    return this.finish(id, 'approved', { ...options, approved: true });
  }

  deny(id: string, options: Omit<AgentToolApprovalResolution, 'approved'> = {}): boolean {
    return this.finish(id, 'denied', { ...options, approved: false });
  }

  cancel(id: string, reason = 'approval request was cancelled'): boolean {
    return this.finish(id, 'cancelled', { approved: false, reason });
  }

  cancelSession(
    sessionId: string,
    reason = 'approval request was superseded by new user input',
  ): number {
    const normalized = sessionId.trim();
    if (!normalized) return 0;
    let cancelled = 0;
    for (const request of this.requests.values()) {
      if (
        request.status === 'pending' &&
        request.sessionId === normalized &&
        this.cancel(request.id, reason)
      ) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private listByStatus(status: AgentToolApprovalRequestStatus): AgentToolApprovalRequest[] {
    return [...this.requests.values()]
      .filter((request) => request.status === status)
      .map(cloneApprovalRequest);
  }

  private createApprovalRequest(request: PermissionRequest): AgentToolApprovalRequest {
    const createdAt = this.now();
    const id = this.createRequestId();
    return {
      id,
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
      argumentPreview: previewArguments(request.toolCall.arguments, this.maxArgumentPreviewChars),
      createdAt,
      updatedAt: createdAt,
    };
  }

  private finish(
    id: string,
    status: Exclude<AgentToolApprovalRequestStatus, 'pending'>,
    resolution: AgentToolApprovalResolution,
  ): boolean {
    const request = this.requests.get(id);
    if (!request || request.status !== 'pending') return false;

    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending?.timeout) clearTimeout(pending.timeout);
    if (pending?.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }

    const resolvedAt = this.now();
    const updated: AgentToolApprovalRequest = {
      ...request,
      status,
      updatedAt: resolvedAt,
      resolvedAt,
      ...(resolution.resolvedBy === undefined ? {} : { resolvedBy: resolution.resolvedBy }),
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    };
    this.requests.set(id, updated);

    pending?.resolve({
      approved: resolution.approved,
      requestId: id,
      ...(resolution.approved ? { approvedAt: resolvedAt } : {}),
      ...(resolution.resolvedBy === undefined ? {} : { approvedBy: resolution.resolvedBy }),
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    });
    return true;
  }

  private defaultRequestId(): string {
    if (globalThis.crypto?.randomUUID) return `approval_${globalThis.crypto.randomUUID()}`;
    this.fallbackRequestId += 1;
    return `approval_${this.fallbackRequestId}`;
  }
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
