import type {
  ArtifactRef,
  DurableResultHandle,
  QueryResultRow,
  ResultHandle,
} from '@dbagent/shared';

export const DATABASE_RESULT_PAGE_LIMIT = 1_000;

export type DatabaseResultAvailability =
  | 'staged'
  | 'available'
  | 'expired'
  | 'deleted'
  | 'corrupt';

export type DatabaseResultStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'NOT_COMMITTED'
  | 'EXPIRED'
  | 'CORRUPT'
  | 'CURSOR_INVALID'
  | 'CONFLICT'
  | 'UNSUPPORTED_SCHEMA'
  | 'STORAGE_FAILURE'
  | 'INJECTED_CRASH';

export class DatabaseResultStoreError extends Error {
  readonly availability: DatabaseResultAvailability | undefined;
  readonly canReexecute: boolean | undefined;

  constructor(
    readonly code: DatabaseResultStoreErrorCode,
    message: string,
    options: {
      availability?: DatabaseResultAvailability;
      canReexecute?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DatabaseResultStoreError';
    this.availability = options.availability;
    this.canReexecute = options.canReexecute;
    Object.defineProperty(this, 'code', { enumerable: true, value: code });
  }
}

export type CreateDatabaseResultInput = {
  resultId?: string;
  jobId: string;
  columns: ResultHandle['columns'];
  format?: ResultHandle['format'];
  hasMore?: boolean;
  truncated?: boolean;
  expiresAt?: string;
};

export interface DatabaseResultWriter {
  readonly resultId: string;
  append(
    rows: readonly QueryResultRow[],
    options?: { operationId?: string },
  ): Promise<void>;
  commit(): Promise<DurableResultHandle>;
  abort(): Promise<void>;
}

export type DatabaseResultPageRequest = {
  cursor?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
};

export type DatabaseResultPage = {
  handleId: string;
  columns: ResultHandle['columns'];
  rows: QueryResultRow[];
  rowOffset: number;
  nextOffset: number;
  nextCursor?: string;
  complete: boolean;
  byteCount: number;
};

export type DatabaseResultDescriptor = {
  id: string;
  projectId: string;
  jobId: string;
  availability: DatabaseResultAvailability;
  rowCount: number;
  byteCount: number;
  checksum?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  canReexecute: boolean;
};

export type DatabaseResultGcOptions = {
  now?: Date;
  stagedTtlMs?: number;
  maxBytes?: number;
  maxResults?: number;
  tombstoneTtlMs?: number;
};

export type DatabaseResultGcReport = {
  stagedResultsDeleted: number;
  orphanObjectsDeleted: number;
  ttlResultsExpired: number;
  capacityResultsExpired: number;
  bytesReclaimed: number;
  tombstonesDeleted: number;
};

export type OpenDatabaseResultExportOptions = {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
};

export interface DatabaseResultStore {
  create(input: CreateDatabaseResultInput): Promise<DatabaseResultWriter>;
  page(
    handle: string | DurableResultHandle,
    request?: DatabaseResultPageRequest,
  ): Promise<DatabaseResultPage>;
  export(handle: string | DurableResultHandle, format: 'csv' | 'jsonl'): Promise<ArtifactRef>;
  openExport(
    artifact: ArtifactRef,
    options?: OpenDatabaseResultExportOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  inspect(resultId: string): Promise<DatabaseResultDescriptor>;
  getHandle(resultId: string): Promise<DurableResultHandle>;
  /** Recovery-only cleanup for an uncommitted result identity. Available results are never removed. */
  discardStaged(resultId: string): Promise<boolean>;
  expire(resultId: string, reason?: string): Promise<boolean>;
  collectGarbage(options?: DatabaseResultGcOptions): Promise<DatabaseResultGcReport>;
}
