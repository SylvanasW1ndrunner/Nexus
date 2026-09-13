import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  parsePublicJson,
  stringifyPublicJson,
  type ArtifactRef,
  type DbColumnValue,
  type DurableResultHandle,
  type QueryResultRow,
  type ResultHandle,
} from '@dbagent/shared';
import { normalizeResultGcOptions } from './result-gc.js';
import { inImmediateTransaction, withResultStoreDatabase } from './result-store-migrations.js';
import {
  DATABASE_RESULT_PAGE_LIMIT,
  DatabaseResultStoreError,
  type CreateDatabaseResultInput,
  type DatabaseResultDescriptor,
  type DatabaseResultGcOptions,
  type DatabaseResultGcReport,
  type DatabaseResultPage,
  type DatabaseResultPageRequest,
  type DatabaseResultStore,
  type DatabaseResultWriter,
  type OpenDatabaseResultExportOptions,
} from './result-store.js';

const DEFAULT_CHUNK_MAX_ROWS = 1_000;
const DEFAULT_CHUNK_MAX_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RESULT_LEASE_DURATION_MS = 60 * 60 * 1_000;
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1_000;
const OBJECT_GATE_STALE_MS = 5 * 60 * 1_000;
const OBJECT_GATE_WAIT_MS = 30_000;
const DEFAULT_EXPORT_IDLE_TIMEOUT_MS = 60_000;
const MAX_RESULT_ID_BYTES = 512;
const MAX_JOB_ID_BYTES = 512;
const MAX_OPERATION_ID_BYTES = 512;
const MAX_COLUMNS = 4_096;
const MAX_COLUMN_NAME_BYTES = 1_024;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_DEPTH = 64;

export type ProjectDatabaseResultStoreFailurePoint =
  | 'after-result-create-before-response'
  | 'after-chunk-object-before-metadata'
  | 'after-chunk-metadata-before-result-commit'
  | 'after-append-metadata-before-response'
  | 'during-export-write'
  | 'after-result-commit-before-response';

export type ProjectDatabaseResultStoreOptions = {
  projectId: string;
  rootDir: string;
  now?: () => Date;
  chunkMaxRows?: number;
  chunkMaxBytes?: number;
  leaseHeartbeatIntervalMs?: number;
  failureAt?: ProjectDatabaseResultStoreFailurePoint;
};

type ResultRow = {
  result_id: string;
  schema_version: number;
  project_id: string;
  job_id: string;
  format: ResultHandle['format'];
  columns_json: string;
  availability: DatabaseResultDescriptor['availability'];
  checksum: string | null;
  row_count: number;
  byte_count: number;
  chunk_count: number;
  has_more: number | null;
  truncated: number | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  expires_at: string | null;
};

type ChunkRow = {
  ordinal: number;
  row_offset: number;
  row_count: number;
  checksum: string;
  byte_count: number;
  object_name: string;
};

type ExportRow = {
  artifact_id: string;
  result_id: string;
  project_id: string;
  checksum: string;
  byte_size: number;
  media_type: string;
  object_name: string;
  created_at: string;
  expires_at: string | null;
};

export class ProjectDatabaseResultStore implements DatabaseResultStore {
  readonly #projectId: string;
  readonly #rootDir: string;
  readonly #databasePath: string;
  readonly #now: () => Date;
  readonly #chunkMaxRows: number;
  readonly #chunkMaxBytes: number;
  readonly #leaseHeartbeatIntervalMs: number;
  readonly #failureAt: ProjectDatabaseResultStoreFailurePoint | undefined;
  readonly #triggeredFailures = new Set<ProjectDatabaseResultStoreFailurePoint>();

  constructor(options: ProjectDatabaseResultStoreOptions) {
    this.#projectId = nonEmpty(options.projectId, 'projectId');
    this.#rootDir = nonEmpty(options.rootDir, 'rootDir');
    this.#databasePath = join(this.#rootDir, 'results.sqlite');
    this.#now = options.now ?? (() => new Date());
    this.#chunkMaxRows = positiveInteger(
      options.chunkMaxRows,
      DEFAULT_CHUNK_MAX_ROWS,
      'chunkMaxRows',
    );
    this.#chunkMaxBytes = positiveInteger(
      options.chunkMaxBytes,
      DEFAULT_CHUNK_MAX_BYTES,
      'chunkMaxBytes',
    );
    this.#leaseHeartbeatIntervalMs = positiveInteger(
      options.leaseHeartbeatIntervalMs,
      DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
      'leaseHeartbeatIntervalMs',
    );
    this.#failureAt = options.failureAt;
  }

  async create(input: CreateDatabaseResultInput): Promise<DatabaseResultWriter> {
    assertCreateInput(input);
    await storageOperation('Unable to initialize the result store directory.', () =>
      mkdir(this.#rootDir, { recursive: true }),
    );
    const resultId = input.resultId ?? randomUUID();
    const now = this.#timestamp();
    const columnsJson = stringifyPublicJson(input.columns);
    const leaseId = randomUUID();
    const ownerId = `${process.pid}:${randomUUID()}`;
    const created = withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        const current = readResult(database, resultId);
        if (current) {
          if (
            current.project_id !== this.#projectId ||
            current.job_id !== input.jobId ||
            current.columns_json !== columnsJson ||
            current.format !== (input.format ?? 'rows') ||
            current.expires_at !== (input.expiresAt ?? null) ||
            current.has_more !== optionalBoolean(input.hasMore) ||
            current.truncated !== optionalBoolean(input.truncated)
          ) {
            conflict(`Result identity is already used by different content: ${resultId}`);
          }
          if (current.availability === 'available') {
            return { current, leaseId: undefined };
          }
          if (current.availability !== 'staged') {
            conflict(`Result identity is not writable: ${resultId}`);
          }
          database.prepare(`
            DELETE FROM database_result_leases
            WHERE result_id = ? AND kind = 'writer' AND expires_at <= ?
          `).run(resultId, now);
          const active = database.prepare(`
            SELECT lease_id FROM database_result_leases
            WHERE result_id = ? AND kind = 'writer' AND expires_at > ? LIMIT 1
          `).get(resultId, now) as { lease_id: string } | undefined;
          if (active) conflict(`Result already has an active writer: ${resultId}`);
          insertLease(
            database, leaseId, resultId, 'writer', ownerId, now,
            leaseExpiry(now),
          );
          return { current, leaseId };
        }
        database.prepare(`
          INSERT INTO database_results (
            result_id, schema_version, project_id, job_id, format, columns_json,
            availability, created_at, updated_at, last_accessed_at, expires_at,
            has_more, truncated
          ) VALUES (?, 1, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?)
        `).run(
          resultId,
          this.#projectId,
          input.jobId,
          input.format ?? 'rows',
          columnsJson,
          now,
          now,
          now,
          input.expiresAt ?? null,
          optionalBoolean(input.hasMore),
          optionalBoolean(input.truncated),
        );
        insertLease(
          database, leaseId, resultId, 'writer', ownerId, now,
          leaseExpiry(now),
        );
        return { current: undefined, leaseId };
      }),
    );
    this.#inject('after-result-create-before-response');
    return new ProjectDatabaseResultWriter(
      this,
      resultId,
      created.current?.availability === 'available',
      created.current?.row_count ?? 0,
      created.leaseId,
      created.leaseId
        ? this.#startLeaseHeartbeat(created.leaseId)
        : undefined,
    );
  }

  async page(
    handle: string | DurableResultHandle,
    request: DatabaseResultPageRequest = {},
  ): Promise<DatabaseResultPage> {
    const resultId = this.#resolveHandleIdentity(handle);
    const leaseId = this.#acquireResultLease(resultId, 'page');
    try {
      const row = await this.#requireReadable(resultId, true);
      assertHandleMatches(handle, row);
      const offset = decodePageOffset(request, resultId, row.checksum!);
      const limit = pageLimit(request.limit);
      if (offset > row.row_count) invalid('offset is beyond the result row count.');
      const end = Math.min(row.row_count, offset + limit);
      const chunks = withResultStoreDatabase(this.#databasePath, (database) =>
        database.prepare(`
          SELECT ordinal, row_offset, row_count, checksum, byte_count, object_name
          FROM database_result_chunks
          WHERE result_id = ? AND row_offset < ? AND row_offset + row_count > ?
          ORDER BY ordinal
        `).all(resultId, end, offset) as unknown as ChunkRow[],
      );
      const rows: QueryResultRow[] = [];
      try {
        for (const chunk of chunks) {
          const decoded = await this.#readChunk(chunk);
          const from = Math.max(offset - chunk.row_offset, 0);
          const to = Math.min(end - chunk.row_offset, decoded.length);
          rows.push(...decoded.slice(from, to));
        }
      } catch (error) {
        if (error instanceof DatabaseResultStoreError) {
          if (error.code === 'CORRUPT') this.#markCorrupt(resultId);
          throw error;
        }
        if (isStorageIoError(error)) {
          throw storageFailure('Unable to read persisted result content.', error);
        }
        this.#markCorrupt(resultId);
        throw corrupt(resultId, error);
      }
      if (rows.length !== end - offset) {
        this.#markCorrupt(resultId);
        throw corrupt(resultId);
      }
      const nextOffset = offset + rows.length;
      const complete = nextOffset >= row.row_count;
      this.#touch(resultId);
      return {
        handleId: resultId,
        columns: decodeColumns(row.columns_json),
        rows,
        rowOffset: offset,
        nextOffset,
        complete,
        byteCount: Buffer.byteLength(stringifyPublicJson(rows)),
        ...(!complete ? { nextCursor: encodeCursor(resultId, nextOffset, row.checksum!) } : {}),
      };
    } finally {
      this.#releaseLease(leaseId);
    }
  }

  async export(
    handle: string | DurableResultHandle,
    format: 'csv' | 'jsonl',
  ): Promise<ArtifactRef> {
    if (format !== 'csv' && format !== 'jsonl') invalid('format must be csv or jsonl.');
    const resultId = this.#resolveHandleIdentity(handle);
    const leaseId = this.#acquireResultLease(resultId, 'export');
    const stopHeartbeat = this.#startLeaseHeartbeat(leaseId);
    try {
      const row = await this.#requireReadable(resultId, true);
      assertHandleMatches(handle, row);
      const chunks = this.#allChunks(resultId);
      const stagingDirectory = join(this.#rootDir, 'staging');
      await storageOperation('Unable to initialize result export staging.', () =>
        mkdir(stagingDirectory, { recursive: true }),
      );
      const temporaryPath = join(stagingDirectory, `export-${randomUUID()}.tmp`);
      const file = await storageOperation('Unable to open the result export destination.', () =>
        open(temporaryPath, 'wx'),
      );
      const hash = createHash('sha256');
      let byteSize = 0;
      const write = async (content: string | Uint8Array): Promise<void> => {
        this.#inject('during-export-write');
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await file.write(
            bytes,
            written,
            bytes.byteLength - written,
            byteSize + written,
          );
          if (result.bytesWritten <= 0) throw new Error('Export write made no progress.');
          written += result.bytesWritten;
        }
        hash.update(bytes);
        byteSize += bytes.byteLength;
      };
      try {
        if (format === 'csv') {
          const columns = decodeColumns(row.columns_json);
          await write(`${columns.map(({ name }) => csvCell(name)).join(',')}\r\n`);
          for (const chunk of chunks) {
            this.#heartbeatLease(leaseId);
            const decoded = await this.#readChunk(chunk);
            for (const item of decoded) {
              await write(`${columns.map(({ name }) => csvCell(item[name])).join(',')}\r\n`);
            }
          }
        } else {
          for (const chunk of chunks) {
            this.#heartbeatLease(leaseId);
            const bytes = await readFile(this.#objectPath('objects', chunk.object_name));
            verifyBytes(bytes, chunk.checksum, chunk.byte_count, resultId);
            await write(bytes);
          }
        }
        await file.sync();
      } catch (error) {
        await file.close();
        await rm(temporaryPath, { force: true });
        if (error instanceof DatabaseResultStoreError && error.code === 'CORRUPT') {
          this.#markCorrupt(resultId);
          throw error;
        }
        if ((error as { code?: unknown })?.code === 'ENOENT') {
          this.#markCorrupt(resultId);
          throw corrupt(resultId, error);
        }
        throw storageFailure('Unable to write the result export.', error);
      }
      await file.close();
      const checksum = hash.digest('hex');
      const objectName = checksumObjectName(checksum);
      const createdAt = this.#timestamp();
      const artifactId = `${resultId}:${format}:${checksum}`;
      const mediaType = format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/x-ndjson; charset=utf-8';
      await this.#withObjectMutationGate(async (heartbeat) => {
        await this.#promote(
          temporaryPath,
          this.#objectPath('exports', objectName),
          checksum,
          byteSize,
        );
        await heartbeat();
        withResultStoreDatabase(this.#databasePath, (database) =>
          inImmediateTransaction(database, () => {
            this.#assertLease(database, leaseId, resultId);
            database.prepare(`
              INSERT INTO database_result_exports (
                artifact_id, result_id, project_id, format, checksum, byte_size,
                media_type, object_name, created_at, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(artifact_id) DO NOTHING
            `).run(
              artifactId, resultId, this.#projectId, format, checksum, byteSize,
              mediaType, objectName, createdAt, row.expires_at,
            );
          }),
        );
      });
      const persisted = withResultStoreDatabase(this.#databasePath, (database) =>
        database.prepare(`
          SELECT artifact_id, result_id, project_id, checksum, byte_size, media_type,
                 object_name, created_at, expires_at
          FROM database_result_exports WHERE artifact_id = ? AND project_id = ?
        `).get(artifactId, this.#projectId) as ExportRow | undefined,
      );
      if (!persisted) throw corrupt(resultId);
      return artifactReference(persisted);
    } finally {
      stopHeartbeat();
      this.#releaseLease(leaseId);
    }
  }

  async openExport(
    artifact: ArtifactRef,
    options: OpenDatabaseResultExportOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const idleTimeoutMs = exportIdleTimeout(options.idleTimeoutMs);
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    if (artifact.schemaVersion !== 1 || artifact.projectId !== this.#projectId) {
      invalid('Artifact reference does not belong to this result store.');
    }
    const stored = withResultStoreDatabase(this.#databasePath, (database) =>
      database.prepare(`
        SELECT artifact_id, result_id, project_id, checksum, byte_size, media_type,
               object_name, created_at, expires_at
        FROM database_result_exports WHERE artifact_id = ? AND project_id = ?
      `).get(artifact.artifactId, this.#projectId) as ExportRow | undefined,
    );
    if (
      !stored ||
      stored.checksum !== artifact.checksum ||
      stored.byte_size !== artifact.byteSize ||
      stored.media_type !== artifact.mediaType ||
      artifact.handle !== `schemanaut-artifact:${artifact.artifactId}` ||
      artifact.availability !== 'available'
    ) {
      throw new DatabaseResultStoreError('NOT_FOUND', 'Export artifact was not found.');
    }
    const leaseId = this.#acquireResultLease(stored.result_id, 'export-read');
    const path = this.#objectPath('exports', stored.object_name);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.#requireReadable(stored.result_id, true);
      file = await open(path, 'r');
      await verifyFileHandle(file, stored.checksum, stored.byte_size, stored.result_id);
    } catch (error) {
      await file?.close();
      this.#releaseLease(leaseId);
      if (error instanceof DatabaseResultStoreError) throw error;
      if (isStorageIoError(error) && (error as { code?: string }).code !== 'ENOENT') {
        throw storageFailure('Unable to open the persisted result export.', error);
      }
      throw corrupt(stored.result_id, error);
    }
    const openedFile = file;
    const stopHeartbeat = this.#startLeaseHeartbeat(leaseId);
    let position = 0;
    let closePromise: Promise<void> | undefined;
    let released = false;
    let controllerReference: ReadableStreamDefaultController<Uint8Array> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.#releaseLease(leaseId);
    };
    const close = async (): Promise<void> => {
      closePromise ??= (async () => {
        try {
          await openedFile.close();
        } finally {
          stopHeartbeat();
          release();
        }
      })();
      await closePromise;
    };
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const fail = async (error: Error) => {
      clearIdleTimer();
      options.signal?.removeEventListener('abort', onAbort);
      await close();
      controllerReference?.error(error);
    };
    const onAbort = () => { void fail(abortError(options.signal?.reason)); };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(
        () => { void fail(abortError('Result export reader was abandoned.')); },
        idleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerReference = controller;
        armIdleTimer();
      },
      pull: async (controller) => {
        try {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          armIdleTimer();
          this.#heartbeatLease(leaseId);
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stored.byte_size - position));
          if (buffer.byteLength === 0) {
            clearIdleTimer();
            options.signal?.removeEventListener('abort', onAbort);
            await close();
            controller.close();
            return;
          }
          const { bytesRead } = await openedFile.read(
            buffer,
            0,
            buffer.byteLength,
            position,
          );
          if (bytesRead === 0) {
            throw corrupt(stored.result_id);
          }
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
          if (position === stored.byte_size) {
            clearIdleTimer();
            options.signal?.removeEventListener('abort', onAbort);
            await close();
            controller.close();
          }
        } catch (error) {
          clearIdleTimer();
          options.signal?.removeEventListener('abort', onAbort);
          await close();
          controller.error(
            error instanceof DatabaseResultStoreError
              ? error
              : isAbortError(error)
                ? error
              : storageFailure('Unable to stream the persisted result export.', error),
          );
        }
      },
      cancel: async () => {
        clearIdleTimer();
        options.signal?.removeEventListener('abort', onAbort);
        await close();
      },
    }, { highWaterMark: 0 });
  }

  async inspect(resultId: string): Promise<DatabaseResultDescriptor> {
    await storageOperation('Unable to initialize the result store directory.', () =>
      mkdir(this.#rootDir, { recursive: true }),
    );
    const row = withResultStoreDatabase(this.#databasePath, (database) => readResult(database, resultId));
    if (!row || row.project_id !== this.#projectId) notFound(resultId);
    if (row.availability === 'available' && isExpired(row.expires_at, this.#now())) {
      if (await this.expire(resultId, 'ttl')) return await this.inspect(resultId);
      throw expired(resultId);
    }
    return descriptor(row);
  }

  async getHandle(resultId: string): Promise<DurableResultHandle> {
    const row = await this.#requireReadable(resultId);
    return handleFromRow(row);
  }

  discardStaged(resultId: string): Promise<boolean> {
    const discarded = withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        const row = readResult(database, resultId);
        if (!row || row.project_id !== this.#projectId || row.availability !== 'staged') {
          return false;
        }
        database.prepare('DELETE FROM database_result_leases WHERE result_id = ?').run(resultId);
        return database.prepare(`
          DELETE FROM database_results
          WHERE result_id = ? AND project_id = ? AND availability = 'staged'
        `).run(resultId, this.#projectId).changes === 1;
      }),
    );
    return Promise.resolve(discarded);
  }

  expire(resultId: string, reason = 'released'): Promise<boolean> {
    const expiredResult = withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        const row = readResult(database, resultId);
        if (!row || row.project_id !== this.#projectId) return false;
        if (row.availability === 'expired' || row.availability === 'deleted') return false;
        const now = this.#timestamp();
        database.prepare('DELETE FROM database_result_leases WHERE expires_at <= ?').run(now);
        const activeLease = database.prepare(`
          SELECT lease_id FROM database_result_leases
          WHERE result_id = ? AND expires_at > ? LIMIT 1
        `).get(resultId, now) as { lease_id: string } | undefined;
        if (activeLease) return false;
        const changed = database.prepare(`
          UPDATE database_results
          SET availability = 'expired', expiration_reason = ?, updated_at = ?
          WHERE result_id = ? AND project_id = ? AND availability IN ('staged', 'available', 'corrupt')
        `).run(reason, now, resultId, this.#projectId).changes;
        return changed === 1;
      }),
    );
    return Promise.resolve(expiredResult);
  }

  async collectGarbage(options: DatabaseResultGcOptions = {}): Promise<DatabaseResultGcReport> {
    await storageOperation('Unable to initialize the result store directory.', () =>
      mkdir(this.#rootDir, { recursive: true }),
    );
    const normalized = normalizeResultGcOptions(options, this.#now());
    const gcNow = new Date(normalized.nowMs).toISOString();
    const report: DatabaseResultGcReport = {
      stagedResultsDeleted: 0,
      orphanObjectsDeleted: 0,
      ttlResultsExpired: 0,
      capacityResultsExpired: 0,
      bytesReclaimed: 0,
      tombstonesDeleted: 0,
    };
    return await this.#withObjectMutationGate(async (heartbeat) => {
      withResultStoreDatabase(this.#databasePath, (database) =>
        inImmediateTransaction(database, () => {
          database.prepare('DELETE FROM database_result_leases WHERE expires_at <= ?').run(gcNow);
          const staged = database.prepare(`
            SELECT result_id FROM database_results AS result
            WHERE project_id = ? AND availability = 'staged'
              AND CAST(strftime('%s', updated_at) AS INTEGER) * 1000 <= ?
              AND NOT EXISTS (
                SELECT 1 FROM database_result_leases AS lease
                WHERE lease.result_id = result.result_id AND lease.expires_at > ?
              )
          `).all(this.#projectId, normalized.stagedBeforeMs, gcNow) as unknown as
            Array<{ result_id: string }>;
          for (const item of staged) {
            database.prepare('DELETE FROM database_results WHERE result_id = ?').run(item.result_id);
            report.stagedResultsDeleted += 1;
          }

          const expiring = database.prepare(`
            SELECT result_id FROM database_results AS result
            WHERE project_id = ? AND availability = 'available' AND expires_at IS NOT NULL
              AND CAST(strftime('%s', expires_at) AS INTEGER) * 1000 <= ?
              AND NOT EXISTS (
                SELECT 1 FROM database_result_leases AS lease
                WHERE lease.result_id = result.result_id AND lease.expires_at > ?
              )
          `).all(this.#projectId, normalized.nowMs, gcNow) as unknown as
            Array<{ result_id: string }>;
          for (const item of expiring) {
            markExpired(database, item.result_id, gcNow, 'ttl');
            report.ttlResultsExpired += 1;
          }

          const available = database.prepare(`
            SELECT result.result_id,
                   result.byte_count + COALESCE((
                     SELECT SUM(export.byte_size) FROM database_result_exports AS export
                     WHERE export.result_id = result.result_id
                   ), 0) AS retained_bytes
            FROM database_results AS result
            WHERE project_id = ? AND availability = 'available'
              AND NOT EXISTS (
                SELECT 1 FROM database_result_leases AS lease
                WHERE lease.result_id = result.result_id AND lease.expires_at > ?
              )
            ORDER BY last_accessed_at DESC, created_at DESC, result_id DESC
          `).all(this.#projectId, gcNow) as unknown as Array<{
            result_id: string;
            retained_bytes: number;
          }>;
          let retainedBytes = available.reduce((sum, item) => sum + item.retained_bytes, 0);
          let retainedResults = available.length;
          for (let index = available.length - 1; index >= 0; index -= 1) {
            const item = available[index]!;
            const bytesExceeded = normalized.maxBytes !== undefined &&
              retainedBytes > normalized.maxBytes;
            const countExceeded = normalized.maxResults !== undefined &&
              retainedResults > normalized.maxResults;
            if (!bytesExceeded && !countExceeded) break;
            markExpired(database, item.result_id, gcNow, 'capacity');
            retainedBytes -= item.retained_bytes;
            retainedResults -= 1;
            report.capacityResultsExpired += 1;
          }
          database.prepare(`
            DELETE FROM database_result_exports WHERE result_id IN (
              SELECT result_id FROM database_results AS result
              WHERE project_id = ? AND availability IN ('expired', 'deleted')
                AND NOT EXISTS (
                  SELECT 1 FROM database_result_leases AS lease
                  WHERE lease.result_id = result.result_id AND lease.expires_at > ?
                )
            )
          `).run(this.#projectId, gcNow);
          database.prepare(`
            DELETE FROM database_result_chunks WHERE result_id IN (
              SELECT result_id FROM database_results AS result
              WHERE project_id = ? AND availability IN ('expired', 'deleted')
                AND NOT EXISTS (
                  SELECT 1 FROM database_result_leases AS lease
                  WHERE lease.result_id = result.result_id AND lease.expires_at > ?
                )
            )
          `).run(this.#projectId, gcNow);
          report.tombstonesDeleted += Number(database.prepare(`
            DELETE FROM database_results
            WHERE project_id = ? AND availability IN ('expired', 'deleted', 'corrupt')
              AND CAST(strftime('%s', updated_at) AS INTEGER) * 1000 <= ?
              AND NOT EXISTS (
                SELECT 1 FROM database_result_leases AS lease
                WHERE lease.result_id = database_results.result_id AND lease.expires_at > ?
              )
          `).run(this.#projectId, normalized.tombstoneBeforeMs, gcNow).changes);
        }),
      );

      const referenced = withResultStoreDatabase(this.#databasePath, (database) =>
        new Set((database.prepare('SELECT DISTINCT object_name FROM database_result_chunks').all() as unknown as
          Array<{ object_name: string }>).map(({ object_name }) => object_name)),
      );
      const hasActiveWriter = withResultStoreDatabase(this.#databasePath, (database) =>
        (database.prepare(`
          SELECT COUNT(*) AS count FROM database_result_leases
          WHERE kind = 'writer' AND expires_at > ?
        `).get(gcNow) as { count: number }).count > 0,
      );
      if (!hasActiveWriter) {
        await collectOrphanFiles(
          join(this.#rootDir, 'staging'),
          new Set(),
          normalized.stagedBeforeMs,
          report,
          heartbeat,
        );
        await collectOrphanFiles(
          join(this.#rootDir, 'objects'),
          referenced,
          normalized.stagedBeforeMs,
          report,
          heartbeat,
        );
      }
      const referencedExports = withResultStoreDatabase(this.#databasePath, (database) =>
        new Set((database.prepare('SELECT DISTINCT object_name FROM database_result_exports').all() as unknown as
          Array<{ object_name: string }>).map(({ object_name }) => object_name)),
      );
      await collectOrphanFiles(
        join(this.#rootDir, 'exports'),
        referencedExports,
        normalized.nowMs,
        report,
        heartbeat,
      );
      if (!hasActiveWriter) {
        await collectOrphanFiles(
          join(this.#rootDir, 'objects'),
          referenced,
          normalized.nowMs,
          report,
          heartbeat,
        );
      }
      return report;
    });
  }

  async _append(
    resultId: string,
    rows: readonly QueryResultRow[],
    expectedRowCount: number,
    leaseId: string,
    operationId: string,
  ): Promise<number> {
    if (rows.length === 0) return expectedRowCount;
    return await this.#withObjectMutationGate(async (heartbeat) => {
      this.#heartbeatLease(leaseId);
      const current = await this.inspect(resultId);
      if (current.availability !== 'staged') conflict(`Result is already finalized: ${resultId}`);
      const encoded = await encodeRowChunks(
        rows,
        this.#chunkMaxRows,
        this.#chunkMaxBytes,
        async () => {
          this.#heartbeatLease(leaseId);
          await heartbeat();
        },
      );
      const inputChecksum = sha256(Buffer.from(
        encoded.flatMap(({ lines }) => lines).join('\n'),
        'utf8',
      ));
      const replay = withResultStoreDatabase(this.#databasePath, (database) =>
        database.prepare(`
          SELECT input_checksum, row_count_after FROM database_result_append_operations
          WHERE result_id = ? AND operation_id = ?
        `).get(resultId, operationId) as {
          input_checksum: string;
          row_count_after: number;
        } | undefined,
      );
      if (replay) {
        if (replay.input_checksum !== inputChecksum) {
          conflict(`Append operation identity is already used by different rows: ${operationId}`);
        }
        return replay.row_count_after;
      }
      const promoted: Array<{
        rowCount: number;
        checksum: string;
        byteCount: number;
        objectName: string;
      }> = [];
      for (const group of encoded) {
        this.#heartbeatLease(leaseId);
        await heartbeat();
        const content = `${group.lines.join('\n')}\n`;
        const bytes = Buffer.from(content, 'utf8');
        const checksum = sha256(bytes);
        const objectName = checksumObjectName(checksum);
        const stagingDirectory = join(this.#rootDir, 'staging');
        await mkdir(stagingDirectory, { recursive: true });
        const temporaryPath = join(stagingDirectory, `chunk-${randomUUID()}.tmp`);
        const file = await open(temporaryPath, 'wx');
        try {
          let written = 0;
          while (written < bytes.byteLength) {
            const result = await file.write(bytes, written, bytes.byteLength - written, written);
            if (result.bytesWritten <= 0) throw new Error('Chunk write made no progress.');
            written += result.bytesWritten;
          }
          await file.sync();
        } finally {
          await file.close();
        }
        await this.#promote(
          temporaryPath,
          this.#objectPath('objects', objectName),
          checksum,
          bytes.byteLength,
        );
        await heartbeat();
        this.#inject('after-chunk-object-before-metadata');
        promoted.push({
          rowCount: group.rowCount,
          checksum,
          byteCount: bytes.byteLength,
          objectName,
        });
      }
      const rowCountAfter = withResultStoreDatabase(this.#databasePath, (database) =>
        inImmediateTransaction(database, () => {
          this.#assertLease(database, leaseId, resultId);
          const result = readResult(database, resultId);
          if (!result || result.project_id !== this.#projectId) notFound(resultId);
          if (result.availability !== 'staged') conflict(`Result is already finalized: ${resultId}`);
          if (result.row_count !== expectedRowCount) {
            conflict(`Concurrent writer advanced result ${resultId}; reopen before retrying.`);
          }
          const aggregate = database.prepare(`
            SELECT COALESCE(MAX(ordinal), -1) AS ordinal,
                   COALESCE(SUM(row_count), 0) AS row_count,
                   COALESCE(SUM(byte_count), 0) AS byte_count
            FROM database_result_chunks WHERE result_id = ?
          `).get(resultId) as { ordinal: number; row_count: number; byte_count: number };
          let ordinal = aggregate.ordinal + 1;
          let rowOffset = aggregate.row_count;
          let appendedBytes = 0;
          for (const chunk of promoted) {
            database.prepare(`
              INSERT INTO database_result_chunks (
                result_id, ordinal, row_offset, row_count, checksum, byte_count, object_name, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              resultId,
              ordinal,
              rowOffset,
              chunk.rowCount,
              chunk.checksum,
              chunk.byteCount,
              chunk.objectName,
              this.#timestamp(),
            );
            ordinal += 1;
            rowOffset += chunk.rowCount;
            appendedBytes += chunk.byteCount;
          }
          database.prepare(`
            UPDATE database_results SET row_count = ?, byte_count = ?, chunk_count = ?,
              updated_at = ?, last_accessed_at = ? WHERE result_id = ?
          `).run(
            rowOffset,
            aggregate.byte_count + appendedBytes,
            ordinal,
            this.#timestamp(),
            this.#timestamp(),
            resultId,
          );
          database.prepare(`
            INSERT INTO database_result_append_operations (
              result_id, operation_id, input_checksum, first_ordinal, chunk_count,
              row_count_before, row_count_after, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            resultId,
            operationId,
            inputChecksum,
            aggregate.ordinal + 1,
            promoted.length,
            aggregate.row_count,
            rowOffset,
            this.#timestamp(),
          );
          return rowOffset;
        }),
      );
      this.#inject('after-append-metadata-before-response');
      return rowCountAfter;
    });
  }

  _commit(resultId: string, leaseId: string | undefined): DurableResultHandle {
    this.#inject('after-chunk-metadata-before-result-commit');
    const row = withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        const current = readResult(database, resultId);
        if (!current || current.project_id !== this.#projectId) notFound(resultId);
        if (current.availability === 'available') return current;
        if (current.availability !== 'staged') {
          throw new DatabaseResultStoreError('CONFLICT', `Result cannot be committed: ${resultId}.`);
        }
        if (!leaseId) conflict(`Result writer lease is missing: ${resultId}`);
        this.#assertLease(database, leaseId, resultId);
        const chunks = readChunks(database, resultId);
        const publicByteCount = current.row_count === 0 ? 2 : current.byte_count + 1;
        const committed = { ...current, byte_count: publicByteCount };
        const checksum = resultChecksum(committed, chunks);
        const now = this.#timestamp();
        const changed = database.prepare(`
          UPDATE database_results SET availability = 'available', checksum = ?, byte_count = ?, updated_at = ?,
            last_accessed_at = ? WHERE result_id = ? AND availability = 'staged'
        `).run(checksum, publicByteCount, now, now, resultId).changes;
        if (changed !== 1) conflict(`Concurrent result commit lost: ${resultId}`);
        database.prepare('DELETE FROM database_result_leases WHERE lease_id = ?').run(leaseId);
        return readResult(database, resultId)!;
      }),
    );
    this.#inject('after-result-commit-before-response');
    return handleFromRow(row);
  }

  _abort(resultId: string, leaseId: string | undefined): void {
    withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        if (leaseId) this.#assertLease(database, leaseId, resultId);
        database.prepare(`
          DELETE FROM database_results
          WHERE result_id = ? AND project_id = ? AND availability = 'staged'
        `).run(resultId, this.#projectId);
        if (leaseId) {
          database.prepare('DELETE FROM database_result_leases WHERE lease_id = ?').run(leaseId);
        }
      }),
    );
  }

  async #requireReadable(resultId: string, leaseProtectsExpiry = false): Promise<ResultRow> {
    const row = withResultStoreDatabase(this.#databasePath, (database) => {
      const current = readResult(database, resultId);
      if (!current || current.project_id !== this.#projectId) notFound(resultId);
      return current;
    });
    if (row.availability === 'staged') {
      throw new DatabaseResultStoreError('NOT_COMMITTED', `Result is not committed: ${resultId}.`, {
        availability: 'staged',
      });
    }
    if (row.availability === 'corrupt') throw corrupt(resultId);
    if (row.availability === 'expired' || row.availability === 'deleted') throw expired(resultId);
    if (!leaseProtectsExpiry && isExpired(row.expires_at, this.#now())) {
      await this.expire(resultId, 'ttl');
      throw expired(resultId);
    }
    if (row.availability !== 'available' || !row.checksum) throw corrupt(resultId);
    const chunks = this.#allChunks(resultId);
    let actualChecksum: string;
    try {
      if (row.schema_version !== 1 || !SHA256_PATTERN.test(row.checksum)) throw new Error();
      actualChecksum = resultChecksum(row, chunks);
    } catch (error) {
      this.#markCorrupt(resultId);
      throw corrupt(resultId, error);
    }
    if (actualChecksum !== row.checksum) {
      this.#markCorrupt(resultId);
      throw corrupt(resultId);
    }
    return row;
  }

  #allChunks(resultId: string): ChunkRow[] {
    return withResultStoreDatabase(this.#databasePath, (database) => readChunks(database, resultId));
  }

  #acquireResultLease(resultId: string, kind: 'page' | 'export' | 'export-read'): string {
    const leaseId = randomUUID();
    const now = this.#timestamp();
    const state = withResultStoreDatabase(this.#databasePath, (database) =>
      inImmediateTransaction(database, () => {
        database.prepare('DELETE FROM database_result_leases WHERE expires_at <= ?').run(now);
        const row = readResult(database, resultId);
        if (!row || row.project_id !== this.#projectId) notFound(resultId);
        if (row.availability !== 'available') return row.availability;
        if (isExpired(row.expires_at, new Date(now))) {
          const active = database.prepare(`
            SELECT lease_id FROM database_result_leases
            WHERE result_id = ? AND expires_at > ? LIMIT 1
          `).get(resultId, now) as { lease_id: string } | undefined;
          if (!active) {
            database.prepare(`
              UPDATE database_results SET availability = 'expired',
                expiration_reason = 'ttl', updated_at = ? WHERE result_id = ?
            `).run(now, resultId);
          }
          return 'expired';
        }
        insertLease(
          database,
          leaseId,
          resultId,
          kind,
          `${process.pid}:${randomUUID()}`,
          now,
          leaseExpiry(now),
        );
        return 'leased';
      }),
    );
    if (state === 'leased') return leaseId;
    if (state === 'expired' || state === 'deleted') throw expired(resultId);
    if (state === 'corrupt') throw corrupt(resultId);
    throw new DatabaseResultStoreError('NOT_COMMITTED', `Result is not committed: ${resultId}.`, {
      availability: 'staged',
    });
  }

  #heartbeatLease(leaseId: string): void {
    const now = this.#timestamp();
    const changed = withResultStoreDatabase(this.#databasePath, (database) =>
      database.prepare(`
        UPDATE database_result_leases SET heartbeat_at = ?, expires_at = ?
        WHERE lease_id = ? AND expires_at > ?
      `).run(now, leaseExpiry(now), leaseId, now).changes,
    );
    if (changed !== 1) conflict(`Result lease is no longer active: ${leaseId}`);
  }

  #startLeaseHeartbeat(leaseId: string): () => void {
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      try {
        this.#heartbeatLease(leaseId);
      } catch {
        // The foreground operation remains authoritative. A stolen or expired
        // lease is reported by its next explicit assertion/heartbeat.
      }
    }, this.#leaseHeartbeatIntervalMs);
    timer.unref();
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
  }

  #assertLease(database: NodeDatabaseSync, leaseId: string, resultId: string): void {
    const now = this.#timestamp();
    const lease = database.prepare(`
      SELECT lease_id FROM database_result_leases
      WHERE lease_id = ? AND result_id = ? AND expires_at > ?
    `).get(leaseId, resultId, now) as { lease_id: string } | undefined;
    if (!lease) conflict(`Result lease is no longer active: ${leaseId}`);
  }

  #releaseLease(leaseId: string): void {
    withResultStoreDatabase(this.#databasePath, (database) => {
      database.prepare('DELETE FROM database_result_leases WHERE lease_id = ?').run(leaseId);
    });
  }

  async #withObjectMutationGate<T>(
    operation: (heartbeat: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const gate = await storageOperation(
      'Unable to acquire the result object mutation gate.',
      () => acquireObjectMutationGate(this.#rootDir),
    );
    try {
      return await storageOperation('Unable to mutate persisted result objects.', () =>
        operation(gate.heartbeat),
      );
    } finally {
      await storageOperation('Unable to release the result object mutation gate.', gate.release);
    }
  }

  async #readChunk(chunk: ChunkRow): Promise<QueryResultRow[]> {
    const bytes = await readFile(this.#objectPath('objects', chunk.object_name));
    verifyBytes(bytes, chunk.checksum, chunk.byte_count, 'result chunk');
    const text = Buffer.from(bytes).toString('utf8');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
    if (lines.length !== chunk.row_count) throw corrupt('result chunk');
    return lines.map((line) => parsePublicJson(line) as QueryResultRow);
  }

  async #promote(
    temporaryPath: string,
    destination: string,
    checksum: string,
    byteSize: number,
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    let promoted = false;
    try {
      await link(temporaryPath, destination);
      promoted = true;
    } catch (error) {
      if (!['EEXIST', 'EACCES', 'EPERM'].includes((error as { code?: string }).code ?? '')) {
        throw error;
      }
      try {
        await verifyFile(destination, checksum, byteSize, 'promoted object');
      } catch (destinationError) {
        if (destinationError instanceof DatabaseResultStoreError) throw destinationError;
        throw error;
      }
    }
    if (promoted) {
      const timestamp = this.#now();
      await utimes(destination, timestamp, timestamp);
      await syncPath(destination);
      await syncDirectory(dirname(destination));
    }
    await rm(temporaryPath, { force: true });
    await verifyFile(destination, checksum, byteSize, 'promoted object');
  }

  #resolveHandleIdentity(handle: string | DurableResultHandle): string {
    if (typeof handle === 'string') return nonEmpty(handle, 'result handle');
    if (
      handle.schemaVersion !== 1 ||
      handle.scheme !== 'schemanaut.database-result' ||
      handle.projectId !== this.#projectId
    ) {
      invalid('Result handle does not belong to this result store.');
    }
    return nonEmpty(handle.id, 'result handle id');
  }

  #touch(resultId: string): void {
    withResultStoreDatabase(this.#databasePath, (database) => {
      database.prepare(`
        UPDATE database_results SET last_accessed_at = ?
        WHERE result_id = ? AND project_id = ?
      `).run(this.#timestamp(), resultId, this.#projectId);
    });
  }

  #markCorrupt(resultId: string): void {
    withResultStoreDatabase(this.#databasePath, (database) => {
      database.prepare(`
        UPDATE database_results SET availability = 'corrupt', updated_at = ?
        WHERE result_id = ? AND project_id = ?
      `).run(this.#timestamp(), resultId, this.#projectId);
    });
  }

  #objectPath(kind: 'objects' | 'exports', objectName: string): string {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{62}$/u.test(objectName)) throw corrupt('object reference');
    const [prefix, suffix] = objectName.split('/');
    return join(this.#rootDir, kind, prefix!, suffix!);
  }

  #timestamp(): string {
    const current = this.#now();
    if (!Number.isFinite(current.getTime())) invalid('now() returned an invalid Date.');
    return current.toISOString();
  }

  #inject(point: ProjectDatabaseResultStoreFailurePoint): void {
    if (this.#failureAt === point && !this.#triggeredFailures.has(point)) {
      this.#triggeredFailures.add(point);
      throw new DatabaseResultStoreError('INJECTED_CRASH', `Injected crash at ${point}.`);
    }
  }
}

class ProjectDatabaseResultWriter implements DatabaseResultWriter {
  #finalized: boolean;
  #expectedRowCount: number;

  constructor(
    private readonly store: ProjectDatabaseResultStore,
    readonly resultId: string,
    alreadyCommitted: boolean,
    initialRowCount: number,
    private readonly leaseId: string | undefined,
    private readonly stopLeaseHeartbeat: (() => void) | undefined,
  ) {
    this.#finalized = alreadyCommitted;
    this.#expectedRowCount = initialRowCount;
  }

  async append(
    rows: readonly QueryResultRow[],
    options: { operationId?: string } = {},
  ): Promise<void> {
    if (this.#finalized) conflict(`Result writer is finalized: ${this.resultId}`);
    if (!this.leaseId) conflict(`Result writer lease is missing: ${this.resultId}`);
    this.#expectedRowCount = await this.store._append(
      this.resultId,
      rows,
      this.#expectedRowCount,
      this.leaseId,
      boundedText(options.operationId ?? randomUUID(), 'operationId', MAX_OPERATION_ID_BYTES),
    );
  }

  commit(): Promise<DurableResultHandle> {
    return Promise.resolve().then(() => {
      try {
        const handle = this.store._commit(this.resultId, this.leaseId);
        this.#finalized = true;
        return handle;
      } finally {
        this.stopLeaseHeartbeat?.();
      }
    });
  }

  abort(): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.#finalized) return;
      try {
        this.store._abort(this.resultId, this.leaseId);
        this.#finalized = true;
      } finally {
        this.stopLeaseHeartbeat?.();
      }
    });
  }
}

function readResult(database: NodeDatabaseSync, resultId: string): ResultRow | undefined {
  return database.prepare(`
    SELECT result_id, schema_version, project_id, job_id, format, columns_json,
           availability, checksum, row_count, byte_count, chunk_count, has_more,
           truncated, created_at, updated_at, last_accessed_at, expires_at
    FROM database_results WHERE result_id = ?
  `).get(resultId) as ResultRow | undefined;
}

function readChunks(database: NodeDatabaseSync, resultId: string): ChunkRow[] {
  return database.prepare(`
    SELECT ordinal, row_offset, row_count, checksum, byte_count, object_name
    FROM database_result_chunks WHERE result_id = ? ORDER BY ordinal
  `).all(resultId) as unknown as ChunkRow[];
}

function resultChecksum(row: ResultRow, chunks: readonly ChunkRow[]): string {
  return sha256(Buffer.from(stringifyPublicJson({
    schemaVersion: row.schema_version,
    projectId: row.project_id,
    jobId: row.job_id,
    format: row.format,
    columns: parsePublicJson(row.columns_json),
    rowCount: row.row_count,
    byteCount: row.byte_count,
    chunks: chunks.map(({ ordinal, row_offset, row_count, checksum, byte_count }) => ({
      ordinal,
      rowOffset: row_offset,
      rowCount: row_count,
      checksum,
      byteCount: byte_count,
    })),
  }), 'utf8'));
}

function handleFromRow(row: ResultRow): DurableResultHandle {
  if (!row.checksum || row.availability !== 'available') throw corrupt(row.result_id);
  return {
    schemaVersion: 1,
    scheme: 'schemanaut.database-result',
    projectId: row.project_id,
    id: row.result_id,
    jobId: row.job_id,
    format: row.format,
    columns: decodeColumns(row.columns_json),
    rowCount: row.row_count,
    byteCount: row.byte_count,
    checksum: row.checksum,
    availability: 'available',
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.has_more === null ? {} : { hasMore: row.has_more === 1 }),
    ...(row.truncated === null ? {} : { truncated: row.truncated === 1 }),
  };
}

function descriptor(row: ResultRow): DatabaseResultDescriptor {
  return {
    id: row.result_id,
    projectId: row.project_id,
    jobId: row.job_id,
    availability: row.availability,
    rowCount: row.row_count,
    byteCount: row.byte_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canReexecute: ['expired', 'deleted', 'corrupt'].includes(row.availability),
    ...(row.checksum === null ? {} : { checksum: row.checksum }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function artifactReference(row: ExportRow): ArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: row.artifact_id,
    handle: `schemanaut-artifact:${row.artifact_id}`,
    projectId: row.project_id,
    checksum: row.checksum,
    byteSize: row.byte_size,
    mediaType: row.media_type,
    availability: 'available',
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function insertLease(
  database: NodeDatabaseSync,
  leaseId: string,
  resultId: string,
  kind: string,
  ownerId: string,
  now: string,
  expiresAt: string,
): void {
  database.prepare(`
    INSERT INTO database_result_leases (
      lease_id, result_id, kind, owner_id, created_at, heartbeat_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(leaseId, resultId, kind, ownerId, now, now, expiresAt);
}

function leaseExpiry(now: string): string {
  return new Date(new Date(now).getTime() + RESULT_LEASE_DURATION_MS).toISOString();
}

function assertHandleMatches(handle: string | DurableResultHandle, row: ResultRow): void {
  if (typeof handle === 'string') return;
  if (
    handle.id !== row.result_id ||
    handle.jobId !== row.job_id ||
    handle.checksum !== row.checksum
  ) {
    invalid('Durable result handle metadata does not match the persisted result.');
  }
}

function decodeColumns(json: string): ResultHandle['columns'] {
  const value = parsePublicJson(json);
  if (!Array.isArray(value)) throw corrupt('columns');
  return value as ResultHandle['columns'];
}

function encodeCursor(resultId: string, offset: number, checksum: string): string {
  const payload = stringifyPublicJson({ schemaVersion: 1, resultId, offset, checksum });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodePageOffset(request: DatabaseResultPageRequest, resultId: string, checksum: string): number {
  if (request.cursor !== undefined && request.offset !== undefined) {
    invalid('cursor and offset are mutually exclusive.');
  }
  if (request.cursor === undefined) {
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer.');
    return offset;
  }
  try {
    const decoded = Buffer.from(request.cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== request.cursor) throw new Error();
    const value = parsePublicJson(decoded) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.resultId !== resultId ||
      value.checksum !== checksum ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      Object.keys(value).sort().join(',') !== 'checksum,offset,resultId,schemaVersion'
    ) throw new Error();
    return value.offset as number;
  } catch {
    throw new DatabaseResultStoreError('CURSOR_INVALID', 'Result cursor is invalid.');
  }
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DATABASE_RESULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DATABASE_RESULT_PAGE_LIMIT) {
    invalid(`limit must be between 1 and ${DATABASE_RESULT_PAGE_LIMIT}.`);
  }
  return limit;
}

async function encodeRowChunks(
  rows: readonly QueryResultRow[],
  maxRows: number,
  maxBytes: number,
  heartbeat: () => Promise<void>,
): Promise<Array<{ lines: string[]; rowCount: number }>> {
  const chunks: Array<{ lines: string[]; rowCount: number }> = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (index % 100 === 0) await heartbeat();
    assertValueDepth(rows[index], 0, new WeakSet<object>());
    const line = stringifyPublicJson(rows[index]);
    const rowBytes = Buffer.byteLength(line) + 1;
    if (rowBytes > MAX_ROW_BYTES) {
      invalid(`A serialized result row must not exceed ${MAX_ROW_BYTES} bytes.`);
    }
    if (current.length > 0 && (current.length >= maxRows || currentBytes + rowBytes > maxBytes)) {
      chunks.push({ lines: current, rowCount: current.length });
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push({ lines: current, rowCount: current.length });
  return chunks;
}

function assertValueDepth(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): void {
  if (depth > MAX_VALUE_DEPTH) {
    invalid(`A result value must not exceed ${MAX_VALUE_DEPTH} nested containers.`);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array) {
    return;
  }
  if (ancestors.has(value)) invalid('Circular result values are not supported.');
  ancestors.add(value);
  try {
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const item of entries) assertValueDepth(item, depth + 1, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function csvCell(value: DbColumnValue | undefined): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = stringifyPublicJson(value);
  else text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markExpired(database: NodeDatabaseSync, resultId: string, now: string, reason: string): void {
  database.prepare(`
    UPDATE database_results SET availability = 'expired', expiration_reason = ?, updated_at = ?
    WHERE result_id = ? AND availability = 'available'
  `).run(reason, now, resultId);
}

function assertCreateInput(input: CreateDatabaseResultInput): void {
  boundedText(input.jobId, 'jobId', MAX_JOB_ID_BYTES);
  if (!Array.isArray(input.columns)) invalid('columns must be an array.');
  if (input.columns.length > MAX_COLUMNS) {
    invalid(`columns must not exceed ${MAX_COLUMNS} entries.`);
  }
  for (const column of input.columns) {
    boundedText(column.name, 'column.name', MAX_COLUMN_NAME_BYTES);
    if (column.dataType !== undefined) {
      boundedText(column.dataType, 'column.dataType', MAX_COLUMN_NAME_BYTES);
    }
    if (column.nativeType !== undefined) {
      boundedText(column.nativeType, 'column.nativeType', MAX_COLUMN_NAME_BYTES);
    }
  }
  if (input.resultId !== undefined) boundedText(input.resultId, 'resultId', MAX_RESULT_ID_BYTES);
  if (input.expiresAt !== undefined && !Number.isFinite(new Date(input.expiresAt).getTime())) {
    invalid('expiresAt must be an ISO date.');
  }
}

function boundedText(value: string, name: string, maxBytes: number): string {
  const normalized = nonEmpty(value, name);
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    invalid(`${name} must not exceed ${maxBytes} bytes.`);
  }
  return normalized;
}

function exportIdleTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_EXPORT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    invalid('idleTimeoutMs must be a positive safe integer.');
  }
  return timeout;
}

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'Result export was aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function optionalBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function checksumObjectName(checksum: string): string {
  if (!SHA256_PATTERN.test(checksum)) throw corrupt('checksum');
  return `${checksum.slice(0, 2)}/${checksum.slice(2)}`;
}

function verifyBytes(
  bytes: Uint8Array,
  expectedChecksum: string,
  expectedBytes: number,
  identity: string,
): void {
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedChecksum) throw corrupt(identity);
}

async function verifyFile(
  path: string,
  expectedChecksum: string,
  expectedBytes: number,
  identity: string,
): Promise<void> {
  const hash = createHash('sha256');
  let byteCount = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    byteCount += bytes.byteLength;
  }
  if (byteCount !== expectedBytes || hash.digest('hex') !== expectedChecksum) throw corrupt(identity);
}

async function syncPath(path: string): Promise<void> {
  const file = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EPERM', 'EINVAL', 'EBADF'].includes((error as { code?: string }).code ?? '')
    ) {
      throw error;
    }
  } finally {
    await directory?.close();
  }
}

async function verifyFileHandle(
  file: Awaited<ReturnType<typeof open>>,
  expectedChecksum: string,
  expectedBytes: number,
  identity: string,
): Promise<void> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== expectedBytes || hash.digest('hex') !== expectedChecksum) throw corrupt(identity);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

async function recursiveFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

async function collectOrphanFiles(
  root: string,
  referenced: ReadonlySet<string>,
  orphanBeforeMs: number,
  report: DatabaseResultGcReport,
  heartbeat: () => Promise<void>,
): Promise<void> {
  for (const path of await recursiveFiles(root)) {
    await heartbeat();
    const objectName = objectNameFromPath(root, path);
    if (referenced.has(objectName)) continue;
    let information;
    try {
      information = await stat(path);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue;
      throw error;
    }
    if (information.mtimeMs > orphanBeforeMs) continue;
    try {
      await rm(path, { force: true });
    } catch (error) {
      if (['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes((error as { code?: string }).code ?? '')) {
        continue;
      }
      throw error;
    }
    report.orphanObjectsDeleted += 1;
    report.bytesReclaimed += information.size;
  }
}

async function acquireObjectMutationGate(rootDir: string): Promise<{
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}> {
  await mkdir(rootDir, { recursive: true });
  const path = join(rootDir, '.object-mutation.lock');
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + OBJECT_GATE_WAIT_MS;
  while (true) {
    try {
      const file = await open(path, 'wx');
      try {
        await file.writeFile(owner, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      try {
        const information = await stat(path);
        if (Date.now() - information.mtimeMs > OBJECT_GATE_STALE_MS) {
          const stalePath = `${path}.stale-${randomUUID()}`;
          try {
            await rename(path, stalePath);
            await rm(stalePath, { force: true });
            continue;
          } catch (staleError) {
            if (!['ENOENT', 'EEXIST', 'EACCES', 'EPERM'].includes(
              (staleError as { code?: string }).code ?? '',
            )) throw staleError;
          }
        }
      } catch (statError) {
        if ((statError as { code?: string }).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new DatabaseResultStoreError(
          'CONFLICT',
          'Timed out waiting for the result object mutation gate.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const stillOwned = async (): Promise<boolean> => {
    try {
      return (await readFile(path, 'utf8')) === owner;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  };
  return {
    heartbeat: async () => {
      if (!await stillOwned()) conflict('Result object mutation gate ownership was lost.');
      const now = new Date();
      await utimes(path, now, now);
    },
    release: async () => {
      if (await stillOwned()) await rm(path, { force: true });
    },
  };
}

function objectNameFromPath(root: string, path: string): string {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/u, '');
  const normalizedPath = path.replaceAll('\\', '/');
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${name} must be a positive integer.`);
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${name} must be non-empty.`);
  return value;
}

function invalid(message: string): never {
  throw new DatabaseResultStoreError('INVALID_ARGUMENT', message);
}

function conflict(message: string): never {
  throw new DatabaseResultStoreError('CONFLICT', message);
}

function notFound(resultId: string): never {
  throw new DatabaseResultStoreError('NOT_FOUND', `Result was not found: ${resultId}.`);
}

function expired(resultId: string): DatabaseResultStoreError {
  return new DatabaseResultStoreError('EXPIRED', `Result expired: ${resultId}.`, {
    availability: 'expired', canReexecute: true,
  });
}

function corrupt(resultId: string, cause?: unknown): DatabaseResultStoreError {
  return new DatabaseResultStoreError('CORRUPT', `Result content is corrupt: ${resultId}.`, {
    availability: 'corrupt', canReexecute: true, ...(cause === undefined ? {} : { cause }),
  });
}

function storageFailure(message: string, cause?: unknown): DatabaseResultStoreError {
  return new DatabaseResultStoreError('STORAGE_FAILURE', message, { cause });
}

async function storageOperation<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DatabaseResultStoreError) throw error;
    throw storageFailure(message, error);
  }
}

function isStorageIoError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && [
    'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EBUSY', 'EIO', 'EDQUOT',
  ].includes(code);
}
