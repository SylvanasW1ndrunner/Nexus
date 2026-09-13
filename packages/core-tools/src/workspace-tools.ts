import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, type BigIntStats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  PREPARED_TOOL_INTENT_REVISION,
  expectedToolError,
  type AgentToolPermissionFacts,
  type PreparedToolIntent,
  type ToolAccess,
  type ToolInvocationContribution,
  type ToolPrepareContext,
  type ToolTargetRevalidator,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import {
  createRipgrepWorkspaceSearchBackend,
  type WorkspaceBinaryMode,
  type WorkspaceSearchBackend,
  type WorkspaceSearchMode,
} from './workspace-search-rg-adapter.js';
import {
  assertNoReplaceWorkspaceMutationAdapter,
  type WorkspaceMutationAdapter,
  type WorkspaceMutationBinding,
  type WorkspaceMutationResult,
  type WorkspacePatchEdit,
} from './workspace-mutation-adapter.js';
import { createLinuxWorkspaceDirectoryBackend } from './workspace-directory-linux-adapter.js';
import { createPortableWorkspaceDirectoryBackend } from './workspace-directory-portable-adapter.js';

const MAX_PATH_CHARS = 4_096;
const DEFAULT_LIST_ENTRIES = 500;
const MAX_LIST_ENTRIES = 2_000;
const MAX_LIST_SCAN_ENTRIES = 8_000;
const MAX_LIST_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_SEARCH_FILES = 10_000;
const MAX_SEARCH_FILES = 20_000;
const DEFAULT_SEARCH_BYTES = 128 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024 * 1024;
const DEFAULT_SEARCH_RESULTS = 200;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_SEARCH_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_SEARCH_TIMEOUT_MS = 30_000;
const MAX_GLOBS = 32;
const MAX_GLOB_CHARS = 512;
const MAX_PATCH_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_EDITS = 100;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const LIMITS = Object.freeze({
  list: Object.freeze({ timeoutMs: 30_000, maxInputBytes: 32 * 1024, maxOutputBytes: 2 * 1024 * 1024, maxArtifactBytes: 4 * 1024 * 1024, maxDepth: 16, maxRecords: 8_000 }),
  read: Object.freeze({ timeoutMs: 30_000, maxInputBytes: 32 * 1024, maxOutputBytes: 1024 * 1024, maxArtifactBytes: 2 * 1024 * 1024, maxDepth: 16, maxRecords: 256 }),
  search: Object.freeze({ timeoutMs: 35_000, maxInputBytes: 64 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxArtifactBytes: 8 * 1024 * 1024, maxDepth: 16, maxRecords: 8_000 }),
  patch: Object.freeze({ timeoutMs: 30_000, maxInputBytes: 8 * 1024 * 1024, maxOutputBytes: 64 * 1024, maxArtifactBytes: 64 * 1024, maxDepth: 16, maxRecords: 1_000 }),
});

export type WorkspaceBaseToolName = 'workspace_list' | 'workspace_read' | 'workspace_search' | 'workspace_apply_patch';
export type WorkspaceDirectoryEntry = Readonly<{
  canonicalPath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes?: number;
  mtimeMs: number;
}>;
export type WorkspaceDirectoryBackend = Readonly<{
  revision: string;
  protocol: 'handle-relative-directory-page.v1' | 'validated-directory-page.v1';
  revalidate(path: string, identity: PortableValue, signal: AbortSignal): Promise<boolean>;
  list(input: Readonly<{
    rootPath: string;
    identity: PortableValue;
    depth: number;
    maxEntries: number;
    maxScanEntries: number;
    maxOutputBytes: number;
    timeoutMs: number;
    ownerKey: string;
    cursor?: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    entries: readonly WorkspaceDirectoryEntry[];
    scannedEntries: number;
    truncated: boolean;
    truncationReasons: readonly string[];
    nextCursor?: string;
  }>>;
}>;
export type WorkspaceToolOptions = Readonly<{
  rootPath: string;
  handlerRevisions?: Partial<Readonly<Record<WorkspaceBaseToolName, string>>>;
  /** Host-only: issued adapter wrapping a certified native no-replace primitive. */
  mutationAdapter?: WorkspaceMutationAdapter;
}>;

const WORKSPACE_GENERATION_BRAND: unique symbol = Symbol('WorkspaceToolGeneration');
const trustedWorkspaceGenerations = new WeakSet<object>();

export type WorkspaceToolGeneration = Readonly<{
  [WORKSPACE_GENERATION_BRAND]: true;
  generationId: string;
  contributions: readonly ToolInvocationContribution[];
  revalidateTarget: ToolTargetRevalidator;
  drain(): Promise<void>;
}>;

/** One inseparable Host generation: handlers and revalidator close over the same backend objects. */
export function createWorkspaceToolGeneration(options: WorkspaceToolOptions): WorkspaceToolGeneration {
  const workspace = new WorkspaceBoundary(options.rootPath);
  const generationId = randomUUID();
  const searchBackend = createRipgrepWorkspaceSearchBackend();
  const directoryBackend = createLinuxWorkspaceDirectoryBackend() ?? createPortableWorkspaceDirectoryBackend();
  const mutationAdapter = options.mutationAdapter ?? null;
  if (mutationAdapter !== null) assertNoReplaceWorkspaceMutationAdapter(mutationAdapter);
  const contributions = deepFreezeWorkspace([
    createWorkspaceListToolContribution(workspace, directoryBackend, generationId, handlerRevision(options, 'workspace_list')),
    createWorkspaceReadToolContribution(workspace, generationId, handlerRevision(options, 'workspace_read')),
    createWorkspaceSearchToolContribution(workspace, searchBackend, generationId, handlerRevision(options, 'workspace_search')),
    createWorkspaceApplyPatchToolContribution(workspace, mutationAdapter, generationId, handlerRevision(options, 'workspace_apply_patch')),
  ]);
  const revalidateTarget = workspaceTargetRevalidator({ searchBackend, directoryBackend, mutationAdapter }, generationId);
  const generation = Object.freeze({ [WORKSPACE_GENERATION_BRAND]: true as const, generationId, contributions, revalidateTarget,
    drain: () => searchBackend.drain() });
  trustedWorkspaceGenerations.add(generation);
  return generation;
}

/** Freeze the entire attested public graph, not just its branded outer shell. */
function deepFreezeWorkspace<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) deepFreezeWorkspace(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export function assertWorkspaceToolGeneration(value: unknown): asserts value is WorkspaceToolGeneration {
  if (value === null || typeof value !== 'object' || !trustedWorkspaceGenerations.has(value)) {
    throw new TypeError('Workspace Tool generation was not issued by the trusted core-tools factory.');
  }
}

/** Host-level prepared-target revalidation for the four workspace tools. */
function workspaceTargetRevalidator(options: Readonly<{
  searchBackend?: WorkspaceSearchBackend | null;
  directoryBackend?: WorkspaceDirectoryBackend | null;
  mutationAdapter?: WorkspaceMutationAdapter | null;
}>, generationId: string): ToolTargetRevalidator {
  const searchBackend = options.searchBackend ?? null;
  return async (intent, context) => {
    const toolName = intent.permission.toolName;
    if (!['workspace_list', 'workspace_search', 'workspace_read', 'workspace_apply_patch'].includes(toolName)) return;
    if (intent.input.workspaceGenerationId !== generationId) return 'target_changed';
    if (intent.targetIdentity === null) return;
    if (toolName === 'workspace_apply_patch') {
      const adapter = options.mutationAdapter ?? null;
      const binding = mutationBinding(intent.targetIdentity);
      if (adapter === null || adapter.protocol !== 'workspace-mutation-cas.v1' || adapter.revision !== binding.adapterRevision) return 'target_changed';
      return await adapter.revalidate(binding, context.signal);
    }
    const identity = entryIdentity(intent.targetIdentity);
    if (toolName === 'workspace_list') {
      const backend = options.directoryBackend ?? null;
      if (backend === null || backend.revision !== intent.input.backendRevision) return 'target_changed';
      return await backend.revalidate(identity.canonicalPath, identity, context.signal) ? undefined : 'target_changed';
    }
    if (toolName === 'workspace_search') {
      const backend = searchBackend;
      if (backend === null || backend.snapshotProtocol !== 'workspace-search-snapshot.v1' || backend.revision !== intent.input.backendRevision) return 'target_changed';
      return await backend.revalidate(identity.canonicalPath, identity, context.signal) ? undefined : 'target_changed';
    }
    if (toolName === 'workspace_read') return await revalidateFileIdentity(identity, context.signal) ? undefined : 'target_changed';
    return;
  };
}

function createWorkspaceListToolContribution(
  workspace: WorkspaceBoundary,
  backend: WorkspaceDirectoryBackend | null,
  generationId: string,
  handlerRevision = 'workspace_list.handler.v1',
): ToolInvocationContribution {
  const toolRevision = 'workspace_list.v1';
  return Object.freeze({
    definition: {
      name: 'workspace_list',
      description: 'List a bounded deterministic page of workspace entries without following symbolic links.',
      aliases: [], tags: ['workspace', 'file', 'directory'],
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARS },
          depth: { type: 'integer', minimum: 1, maximum: 8 },
          maxEntries: { type: 'integer', minimum: 1, maximum: MAX_LIST_ENTRIES },
          cursor: { type: 'string', minLength: 1, maxLength: 8_192 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'partial', 'unavailable'] }, reason: { type: 'string' },
          summary: { type: 'string' }, path: { type: 'string' }, identity: { type: 'object' },
          entries: { type: 'array', items: { type: 'object', properties: {
            path: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] },
            sizeBytes: { type: 'integer', minimum: 0 }, mtimeMs: { type: 'number' },
          }, required: ['path', 'type', 'mtimeMs'], additionalProperties: false } },
          scannedEntries: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' },
          truncationReasons: { type: 'array', items: { type: 'string' } }, nextCursor: { type: 'string' },
        },
        required: ['status', 'summary', 'entries', 'scannedEntries', 'truncated', 'truncationReasons'],
        additionalProperties: false,
      },
      dangerLevel: 'safe', readonly: true, source: 'runtime', exposure: 'direct',
      permission: { actions: ['read'] }, access: 'read', recoveryClass: 'read', limits: LIMITS.list,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: LIMITS.list.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'file', preparingMessage: '正在列出工作区目录。', inputPreview: { argument: 'path', label: 'Path' } },
    },
    runtime: {
      revision: revisionReference('workspace_list', toolRevision, handlerRevision),
      async prepare(input, context) {
        const requestedPath = optionalBoundedString(input.path, 'path', MAX_PATH_CHARS) ?? '.';
        const depth = optionalInteger(input.depth, 'depth', 1, 8) ?? 2;
        const maxEntries = optionalInteger(input.maxEntries, 'maxEntries', 1, MAX_LIST_ENTRIES) ?? DEFAULT_LIST_ENTRIES;
        const canonicalPath = await workspace.existingDirectory(requestedPath);
        const identity = await snapshotEntry(canonicalPath);
        const backendRevision = backend?.revision ?? 'unavailable';
        const ownerKey = invocationOwner(context);
        const binding = cursorBinding('list', { canonicalPath, identity, depth, backendRevision, ownerKey });
        const after = decodeCursor(optionalBoundedString(input.cursor, 'cursor', 8_192), 'list', binding);
        return makeIntent(context, {
          input: { canonicalPath, requestedPath, depth, maxEntries, binding, backendRevision, workspaceGenerationId: generationId,
            ownerKey, ...(after === undefined ? {} : { after }) },
          targetIdentity: backend === null ? null : identity,
          action: `List up to ${maxEntries} entries from ${workspace.display(canonicalPath)}.`,
          permission: readPermission('workspace_list', canonicalPath, identity),
          access: 'read', recoveryClass: 'read', concurrency: 'read', resourceKey: workspace.resourceKey(canonicalPath),
        });
      },
      async execute(input, context) {
        const canonicalPath = stringField(input, 'canonicalPath');
        if (backend === null) return unavailableList('strong_directory_backend_unavailable');
        if (backend.revision !== stringField(input, 'backendRevision')) {
          throw expectedToolError('conflict', 'The prepared directory backend changed.');
        }
        const identity = entryIdentity(context.intent.targetIdentity);
        const cursor = optionalStringField(input, 'after');
        const maxEntries = numberField(input, 'maxEntries');
        const maxScanEntries = Math.min(maxEntries, MAX_LIST_SCAN_ENTRIES);
        const result = await backend.list({ rootPath: canonicalPath, identity, depth: numberField(input, 'depth'),
          maxEntries, maxScanEntries, maxOutputBytes: MAX_LIST_OUTPUT_BYTES, timeoutMs: LIMITS.list.timeoutMs,
          ownerKey: stringField(input, 'ownerKey'), ...(cursor === undefined ? {} : { cursor }), signal: context.signal });
        if (result.entries.length > maxEntries || result.scannedEntries > maxScanEntries ||
          Buffer.byteLength(JSON.stringify(result.entries), 'utf8') > MAX_LIST_OUTPUT_BYTES) {
          throw expectedToolError('limit', 'The directory backend exceeded its prepared bounds.');
        }
        if (!Number.isSafeInteger(result.scannedEntries) || result.scannedEntries < 0 ||
          result.truncationReasons.length > 8 || result.truncationReasons.some((reason) =>
            !['entry_limit', 'byte_limit', 'scan_limit', 'time_limit'].includes(reason)) ||
          result.nextCursor !== undefined && (result.nextCursor.length < 1 || result.nextCursor.length > 8_192 || result.nextCursor === cursor)) {
          throw expectedToolError('external', 'The directory backend returned an invalid bounded page.');
        }
        let previous = '';
        const entries = result.entries.map((entry) => {
          workspace.assertInside(entry.canonicalPath);
          if (previous !== '' && compare(previous, entry.canonicalPath) >= 0) throw expectedToolError('external', 'The directory backend returned unstable ordering.');
          if (!['file', 'directory', 'symlink', 'other'].includes(entry.type) || !Number.isFinite(entry.mtimeMs) ||
            entry.sizeBytes !== undefined && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) {
            throw expectedToolError('external', 'The directory backend returned invalid entry metadata.');
          }
          previous = entry.canonicalPath;
          return { path: workspace.display(entry.canonicalPath), type: entry.type,
            ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }), mtimeMs: entry.mtimeMs };
        });
        return {
          status: result.truncated ? 'partial' : 'ok', summary: `Listed ${entries.length} workspace entries.`, path: workspace.display(canonicalPath), identity,
          entries, scannedEntries: result.scannedEntries, truncated: result.truncated,
          truncationReasons: result.truncationReasons,
          ...(result.nextCursor === undefined ? {} : { nextCursor: encodeCursor('list', stringField(input, 'binding'), result.nextCursor) }),
        };
      },
    },
  } satisfies ToolInvocationContribution);
}

function createWorkspaceReadToolContribution(
  workspace: WorkspaceBoundary,
  generationId: string,
  handlerRevision = 'workspace_read.handler.v1',
): ToolInvocationContribution {
  const toolRevision = 'workspace_read.v1';
  return Object.freeze({
    definition: {
      name: 'workspace_read',
      description: 'Read a bounded line or byte range and return canonical file identity, digest, mtime and total size.',
      aliases: [], tags: ['workspace', 'file', 'read'],
      inputSchema: { type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARS }, mode: { type: 'string', enum: ['auto', 'line', 'byte'] },
        startLine: { type: 'integer', minimum: 1, maximum: 10_000_000 }, endLine: { type: 'integer', minimum: 1, maximum: 10_000_000 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
        maxScanBytes: { type: 'integer', minimum: 1, maximum: 67_108_864 },
        maxDigestBytes: { type: 'integer', minimum: 0, maximum: 67_108_864 },
      }, required: ['path'], additionalProperties: false },
      outputSchema: { type: 'object', properties: {
        status: { type: 'string', enum: ['ok', 'partial'] }, summary: { type: 'string' }, path: { type: 'string' },
        canonicalPath: { type: 'string' }, identity: { type: 'object' }, digest: { type: 'string' },
        digestStatus: { type: 'string', enum: ['complete', 'unavailable'] }, mtimeMs: { type: 'number' },
        totalBytes: { type: 'integer', minimum: 0 }, totalLines: { type: 'integer', minimum: 0 }, contentType: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'image', 'binary'] }, range: { type: 'object' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'] }, content: { type: 'string' }, truncated: { type: 'boolean' },
        nextOffset: { type: 'integer', minimum: 0 }, nextLine: { type: 'integer', minimum: 1 },
      }, required: ['status', 'summary', 'path', 'canonicalPath', 'identity', 'digestStatus', 'mtimeMs', 'totalBytes', 'contentType', 'kind', 'range', 'encoding', 'content', 'truncated'], additionalProperties: false },
      dangerLevel: 'safe', readonly: true, source: 'runtime', exposure: 'direct', permission: { actions: ['read'] },
      access: 'read', recoveryClass: 'read', limits: LIMITS.read, toolRevision, handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION, execution: { concurrency: 'read', timeoutMs: LIMITS.read.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'file', preparingMessage: '正在读取工作区文件。', inputPreview: { argument: 'path', label: 'Path' } },
    },
    runtime: {
      revision: revisionReference('workspace_read', toolRevision, handlerRevision),
      async prepare(input, context) {
        const requestedPath = boundedString(input.path, 'path', MAX_PATH_CHARS);
        const requestedMode = readMode(input.mode);
        const mode = requestedMode === 'auto' && input.offset !== undefined
          ? 'byte'
          : requestedMode === 'auto' && (input.startLine !== undefined || input.endLine !== undefined)
            ? 'line'
            : requestedMode;
        const startLine = optionalInteger(input.startLine, 'startLine', 1, 10_000_000) ?? 1;
        const endLine = optionalInteger(input.endLine, 'endLine', 1, 10_000_000) ?? startLine + 199;
        if (endLine < startLine) throw expectedToolError('invalid_argument', 'endLine must not precede startLine.');
        const offset = optionalInteger(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
        const limit = optionalInteger(input.limit, 'limit', 1, MAX_READ_BYTES) ?? DEFAULT_READ_BYTES;
        const maxScanBytes = optionalInteger(input.maxScanBytes, 'maxScanBytes', 1, 64 * 1024 * 1024) ?? 4 * 1024 * 1024;
        const maxDigestBytes = optionalInteger(input.maxDigestBytes, 'maxDigestBytes', 0, 64 * 1024 * 1024) ?? 8 * 1024 * 1024;
        if (mode === 'line' && input.offset !== undefined) throw expectedToolError('invalid_argument', 'offset is only valid for byte reads.');
        if (mode === 'byte' && (input.startLine !== undefined || input.endLine !== undefined)) throw expectedToolError('invalid_argument', 'startLine/endLine are only valid for line reads.');
        const canonicalPath = await workspace.existingFile(requestedPath);
        const identity = await snapshotEntry(canonicalPath);
        return makeIntent(context, {
          input: { canonicalPath, requestedPath, mode, startLine, endLine, offset, limit, maxScanBytes, maxDigestBytes,
            workspaceGenerationId: generationId }, targetIdentity: identity,
          action: `Read a bounded ${mode} range from ${workspace.display(canonicalPath)}.`,
          permission: readPermission('workspace_read', canonicalPath, identity), access: 'read', recoveryClass: 'read', concurrency: 'read',
          resourceKey: workspace.resourceKey(canonicalPath),
        });
      },
      async execute(input, context) {
        const path = stringField(input, 'canonicalPath');
        const expected = entryIdentity(context.intent.targetIdentity);
        const handle = await open(path, 'r').catch((error) => { throw workspaceFilesystemError(error); });
        try {
          const before = await snapshotHandle(handle, path);
          assertSameIdentity(before, expected);
          const sample = await readSample(handle, before.sizeBytes, context.signal);
          const requestedMode = readMode(input.mode);
          const kind = contentKind(path, sample);
          const mode = requestedMode === 'auto' ? (kind === 'text' ? 'line' : 'byte') : requestedMode;
          const result = mode === 'line' && kind === 'text'
            ? await readLineRange(handle, numberField(input, 'startLine'), numberField(input, 'endLine'), numberField(input, 'limit'), numberField(input, 'maxScanBytes'), before.sizeBytes, context.signal)
            : await readByteRange(handle, numberField(input, 'offset'), numberField(input, 'limit'), before.sizeBytes, context.signal);
          assertSameIdentity(await snapshotHandle(handle, path), before);
          const inspection = before.sizeBytes <= numberField(input, 'maxDigestBytes')
            ? await inspectHandle(handle, before, context.signal)
            : undefined;
          return {
            status: result.truncated ? 'partial' : 'ok', summary: `Read ${result.bytesRead} bytes from ${workspace.display(path)}.`,
            path: workspace.display(path), canonicalPath: path, identity: before,
            ...(inspection === undefined ? { digestStatus: 'unavailable' } : { digestStatus: 'complete', digest: inspection.digest }),
            mtimeMs: before.mtimeMs, totalBytes: before.sizeBytes,
            ...(inspection !== undefined && kind === 'text' ? { totalLines: inspection.totalLines } : {}), contentType: mediaType(path, kind), kind,
            range: result.range, encoding: result.encoding, content: result.content, truncated: result.truncated,
            ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
            ...(result.nextLine === undefined ? {} : { nextLine: result.nextLine }),
          };
        } finally { await handle.close(); }
      },
    },
  } satisfies ToolInvocationContribution);
}

function createWorkspaceSearchToolContribution(
  workspace: WorkspaceBoundary,
  backend: WorkspaceSearchBackend | null,
  generationId: string,
  handlerRevision = 'workspace_search.handler.v1',
): ToolInvocationContribution {
  const toolRevision = 'workspace_search.v1';
  return Object.freeze({
    definition: {
      name: 'workspace_search',
      description: 'Search with bounded ripgrep-compatible ignore, glob, regex, literal, binary and Unicode behavior.',
      aliases: [], tags: ['workspace', 'search', 'ripgrep'],
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', minLength: 1, maxLength: 8_192 }, path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARS },
        mode: { type: 'string', enum: ['literal', 'regex'] }, caseSensitive: { type: 'boolean' }, binary: { type: 'string', enum: ['exclude', 'include'] },
        globs: { type: 'array', maxItems: MAX_GLOBS, items: { type: 'string', minLength: 1, maxLength: MAX_GLOB_CHARS } },
        maxFiles: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_FILES }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_BYTES },
        maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS }, timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_TIMEOUT_MS },
        cursor: { type: 'string', minLength: 1, maxLength: 8_192 },
      }, required: ['query'], additionalProperties: false },
      outputSchema: { type: 'object', properties: {
        status: { type: 'string', enum: ['ok', 'partial', 'unavailable'] }, summary: { type: 'string' }, reason: { type: 'string' }, query: { type: 'string' },
        path: { type: 'string' }, backendRevision: { type: 'string' }, matches: { type: 'array', items: { type: 'object', properties: {
          path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, byteColumn: { type: 'integer', minimum: 1 }, text: { type: 'string' }, match: { type: 'string' },
          digest: { type: 'string' }, mtimeMs: { type: 'number' }, sizeBytes: { type: 'integer', minimum: 0 },
        }, required: ['path', 'line', 'byteColumn', 'text', 'match', 'digest', 'mtimeMs', 'sizeBytes'], additionalProperties: false } },
        scannedFiles: { type: 'integer', minimum: 0 }, scannedBytes: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' },
        truncationReasons: { type: 'array', items: { type: 'string' } }, nextCursor: { type: 'string' },
      }, required: ['status', 'summary', 'matches', 'scannedFiles', 'scannedBytes', 'truncated', 'truncationReasons'], additionalProperties: false },
      dangerLevel: 'safe', readonly: true, source: 'runtime', exposure: 'direct', permission: { actions: ['read'] },
      access: 'read', recoveryClass: 'read', limits: LIMITS.search, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: LIMITS.search.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'search', preparingMessage: '正在搜索工作区文件。', inputPreview: { argument: 'query', label: 'Query' } },
    },
    runtime: {
      revision: revisionReference('workspace_search', toolRevision, handlerRevision),
      async prepare(input, context) {
        const query = boundedString(input.query, 'query', 8_192);
        const requestedPath = optionalBoundedString(input.path, 'path', MAX_PATH_CHARS) ?? '.';
        const mode = searchMode(input.mode); const caseSensitive = optionalBoolean(input.caseSensitive, 'caseSensitive') ?? false;
        const binary = binaryMode(input.binary); const globs = stringArray(input.globs, 'globs', MAX_GLOBS, MAX_GLOB_CHARS);
        const maxFiles = optionalInteger(input.maxFiles, 'maxFiles', 1, MAX_SEARCH_FILES) ?? DEFAULT_SEARCH_FILES;
        const maxBytes = optionalInteger(input.maxBytes, 'maxBytes', 1, MAX_SEARCH_BYTES) ?? DEFAULT_SEARCH_BYTES;
        const maxResults = optionalInteger(input.maxResults, 'maxResults', 1, MAX_SEARCH_RESULTS) ?? DEFAULT_SEARCH_RESULTS;
        const timeoutMs = optionalInteger(input.timeoutMs, 'timeoutMs', 1, MAX_SEARCH_TIMEOUT_MS) ?? DEFAULT_SEARCH_TIMEOUT_MS;
        const path = await workspace.existing(requestedPath); const identity = await snapshotEntry(path);
        if (identity.type !== 'file' && identity.type !== 'directory') throw expectedToolError('precondition', 'Search requires a file or directory.');
        const backendRevision = backend?.revision ?? 'unavailable';
        const ownerKey = invocationOwner(context);
        const binding = cursorBinding('search', { path, identity, query, mode, caseSensitive, binary, globs, backendRevision, ownerKey });
        const after = decodeCursor(optionalBoundedString(input.cursor, 'cursor', 8_192), 'search', binding);
        return makeIntent(context, {
          input: { path, requestedPath, query, mode, caseSensitive, binary, globs, maxFiles, maxBytes, maxResults, timeoutMs, binding,
            backendRevision, ownerKey, workspaceGenerationId: generationId, ...(after === undefined ? {} : { after }) },
          targetIdentity: identity.type === 'directory' && backend?.targets !== 'file-and-directory'
            ? null
            : { ...identity, backendRevision }, action: `Search ${workspace.display(path)} for a bounded ${mode} query.`,
          permission: readPermission('workspace_search', path, identity), access: 'read', recoveryClass: 'read', concurrency: 'read', resourceKey: workspace.resourceKey(path),
        });
      },
      async execute(input, context) {
        const path = stringField(input, 'path');
        if (backend === null) return unavailableSearch('search_backend_unavailable');
        if (backend.snapshotProtocol !== 'workspace-search-snapshot.v1' || backend.revision !== stringField(input, 'backendRevision')) {
          throw expectedToolError('conflict', 'The search backend changed after prepare.');
        }
        if (context.intent.targetIdentity === null) return unavailableSearch('strong_directory_snapshot_unavailable');
        const targetIdentity = entryIdentity(context.intent.targetIdentity);
        await assertEntryIdentity(path, targetIdentity);
        const after = optionalStringField(input, 'after');
        const result = await backend.search({
          targetPath: path, targetIdentity, relativePath: workspace.display(path), ownerKey: stringField(input, 'ownerKey'),
          query: stringField(input, 'query'), mode: searchMode(input.mode), caseSensitive: booleanField(input, 'caseSensitive'),
          binary: binaryMode(input.binary), globs: stringArray(input.globs, 'globs', MAX_GLOBS, MAX_GLOB_CHARS), maxFiles: numberField(input, 'maxFiles'),
          maxScanBytes: numberField(input, 'maxBytes'), maxResults: numberField(input, 'maxResults'), maxOutputBytes: MAX_SEARCH_OUTPUT_BYTES,
          timeoutMs: numberField(input, 'timeoutMs'), ...(after === undefined ? {} : { after }), signal: context.signal,
        });
        if (result.status === 'unavailable') return unavailableSearch(result.reason ?? 'search_backend_unavailable');
        const matches = [];
        for (const match of result.matches) {
          workspace.assertInside(match.canonicalPath); throwIfAborted(context.signal);
          const file = entryIdentity(match.identity);
          matches.push({ path: workspace.display(match.canonicalPath), line: match.line, byteColumn: match.byteColumn, text: match.text, match: match.match,
            digest: match.digest, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes });
        }
        const reasons = new Set(result.truncationReasons); const truncated = result.truncated;
        const lastKey = result.matches.at(matches.length - 1)?.key;
        return { status: truncated ? 'partial' : 'ok', summary: `Found ${matches.length} workspace matches.`, query: stringField(input, 'query'),
          path: workspace.display(path), backendRevision: backend.revision, matches, scannedFiles: result.scannedFiles, scannedBytes: result.scannedBytes,
          truncated, truncationReasons: [...reasons].sort(compare),
          ...(truncated && lastKey !== undefined ? { nextCursor: encodeCursor('search', stringField(input, 'binding'), lastKey) } : {}) };
      },
    },
  } satisfies ToolInvocationContribution);
}

function createWorkspaceApplyPatchToolContribution(
  workspace: WorkspaceBoundary,
  adapter: WorkspaceMutationAdapter | null,
  generationId: string,
  handlerRevision = 'workspace_apply_patch.handler.v1',
): ToolInvocationContribution {
  const toolRevision = 'workspace_apply_patch.v1';
  return Object.freeze({
    definition: {
      name: 'workspace_apply_patch',
      description: 'Atomically create, conditionally patch, or conditionally delete one file using a canonical target and digest.',
      aliases: [], tags: ['workspace', 'file', 'patch', 'write'],
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] }, path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARS },
        content: { type: 'string', maxLength: MAX_PATCH_INPUT_BYTES }, expectedDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        edits: { type: 'array', minItems: 1, maxItems: MAX_PATCH_EDITS, items: { type: 'object', properties: {
          oldText: { type: 'string', minLength: 1, maxLength: MAX_PATCH_INPUT_BYTES }, newText: { type: 'string', maxLength: MAX_PATCH_INPUT_BYTES }, replaceAll: { type: 'boolean' },
        }, required: ['oldText', 'newText'], additionalProperties: false } },
      }, required: ['action', 'path'], allOf: [
        { if: { properties: { action: { const: 'create' } }, required: ['action'] }, then: { required: ['content'], not: { anyOf: [{ required: ['expectedDigest'] }, { required: ['edits'] }] } } },
        { if: { properties: { action: { const: 'update' } }, required: ['action'] }, then: { required: ['expectedDigest', 'edits'], not: { required: ['content'] } } },
        { if: { properties: { action: { const: 'delete' } }, required: ['action'] }, then: { required: ['expectedDigest'], not: { anyOf: [{ required: ['content'] }, { required: ['edits'] }] } } },
      ], additionalProperties: false },
      outputSchema: { type: 'object', properties: {
        status: { type: 'string', enum: ['ok', 'unavailable'] }, reason: { type: 'string' },
        summary: { type: 'string' }, action: { type: 'string', enum: ['create', 'update', 'delete'] }, path: { type: 'string' }, canonicalPath: { type: 'string' },
        previousDigest: { type: 'string' }, digest: { type: 'string' }, sizeBytes: { type: 'integer', minimum: 0 }, replacements: { type: 'integer', minimum: 0 },
        deleted: { type: 'boolean' }, identity: { type: 'object' },
      }, required: ['status', 'summary', 'action', 'path', 'canonicalPath'], additionalProperties: false },
      dangerLevel: 'high', readonly: false, source: 'runtime', exposure: 'direct', access: 'destructive', recoveryClass: 'transactional', limits: LIMITS.patch,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION, execution: { concurrency: 'write', timeoutMs: LIMITS.patch.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } }, completion: { role: 'deliverable', group: 'workspace-artifact' },
      presentation: { category: 'file', preparingMessage: '正在应用工作区补丁。', inputPreview: { argument: 'path', label: 'Path' } },
    },
    runtime: {
      revision: revisionReference('workspace_apply_patch', toolRevision, handlerRevision),
      async prepare(input, context) {
        const action = patchAction(input.action); const requestedPath = boundedString(input.path, 'path', MAX_PATH_CHARS);
        const content = action === 'create' ? boundedContent(input.content) : undefined;
        const edits = action === 'update' ? patchEdits(input.edits) : undefined;
        const expectedDigest = action === 'create' ? undefined : digestField(input.expectedDigest);
        if (adapter === null) {
          workspace.lexicalPatchTarget(requestedPath);
          return makeIntent(context, {
            input: { action, requestedPath, unavailableReason: 'conditional_mutation_backend_unavailable', workspaceGenerationId: generationId }, targetIdentity: null,
            action: 'Check whether conditional workspace mutation is available on this Host.',
            permission: availabilityPermission(), access: 'read', recoveryClass: 'read', concurrency: 'read',
            resourceKey: 'workspace:mutation-availability',
          });
        }
        if (adapter.protocol !== 'workspace-mutation-cas.v1') throw expectedToolError('precondition', 'The mutation backend lacks conditional commit support.');
        const binding = await adapter.prepare({ rootPath: workspace.rootPath, requestedPath, action,
          ...(expectedDigest === undefined ? {} : { expectedDigest }), ...(content === undefined ? {} : { desiredContent: content }),
          transactionKey: `${context.invocationId}:${context.idempotencyKey}`, signal: context.signal });
        const access = patchAccess(action, binding.insideWorkspace);
        return makeIntent(context, {
          input: { action, requestedPath, binding, workspaceGenerationId: generationId,
            ...(content === undefined ? {} : { content }), ...(edits === undefined ? {} : { edits }) },
          targetIdentity: binding,
          action: `${action} ${binding.insideWorkspace ? 'workspace' : 'external'} file ${binding.canonicalPath}.`,
          permission: mutationPermission(action, access, binding), access, recoveryClass: 'transactional', concurrency: 'write',
          resourceKey: workspace.resourceKey(binding.canonicalPath),
        });
      },
      async execute(input, context) {
        const action = patchAction(input.action);
        if (input.unavailableReason !== undefined || adapter === null) {
          const target = workspace.lexicalPatchTarget(stringField(input, 'requestedPath'));
          return unavailableMutation(action, target.path, workspace.displayExternal(target.path));
        }
        const binding = mutationBinding(requiredField(input, 'binding'));
        const validation = await adapter.revalidate(binding, context.signal);
        if (validation !== undefined) throw expectedToolError('conflict', 'The prepared mutation target changed before execution.');
        const result = await adapter.execute(binding, {
          ...(input.content === undefined ? {} : { desiredContent: stringField(input, 'content') }),
          ...(input.edits === undefined ? {} : { edits: patchEdits(input.edits) }), signal: context.signal,
        });
        return mutationPayload(result);
      },
      async recover(input, context) {
        if (adapter === null || input.unavailableReason !== undefined) {
          const action = patchAction(input.action); const target = workspace.lexicalPatchTarget(stringField(input, 'requestedPath'));
          return unavailableMutation(action, target.path, workspace.displayExternal(target.path));
        }
        return mutationPayload(await adapter.recover(mutationBinding(requiredField(input, 'binding')), context.signal));
      },
    },
  } satisfies ToolInvocationContribution);
}

class WorkspaceBoundary {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = realpathSync(resolve(rootPath));
  }

  async existing(input: string): Promise<string> {
    const target = this.resolveWorkspacePath(input);
    const canonical = await realpath(target).catch((error) => { throw workspaceFilesystemError(error); });
    this.assertInside(canonical);
    return canonical;
  }

  async existingFile(input: string): Promise<string> {
    const path = await this.existing(input);
    if (!(await stat(path)).isFile()) throw expectedToolError('precondition', 'Select a regular file.');
    return path;
  }

  async existingDirectory(input: string): Promise<string> {
    const path = await this.existing(input);
    if (!(await stat(path)).isDirectory()) throw expectedToolError('precondition', 'Select a directory.');
    return path;
  }

  /** Workspace-only target canonicalizer retained for process cwd preparation. */
  async target(input: string): Promise<string> {
    const target = this.resolveWorkspacePath(input);
    const parent = await realpath(dirname(target)).catch((error) => { throw workspaceFilesystemError(error); });
    this.assertInside(parent);
    return join(parent, basename(target));
  }

  lexicalPatchTarget(input: string): Readonly<{ path: string; insideWorkspace: boolean }> {
    const lexical = isAbsolute(input) ? resolve(input) : resolve(this.rootPath, input);
    if (lexical === dirname(lexical)) throw expectedToolError('invalid_argument', 'A file path is required.');
    return Object.freeze({ path: lexical, insideWorkspace: this.isInside(lexical) });
  }

  display(path: string): string {
    return relative(this.rootPath, path).replaceAll('\\', '/') || '.';
  }

  displayExternal(path: string): string {
    return this.isInside(path) ? this.display(path) : path;
  }

  resourceKey(path: string): string {
    const key = `workspace:${process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path}`;
    if (key.length > MAX_PATH_CHARS) throw expectedToolError('limit', 'The canonical workspace path is too long.');
    return key;
  }

  assertInside(path: string): void {
    if (!this.isInside(path)) throw expectedToolError('precondition', 'The requested path is outside the workspace.');
  }

  isInside(path: string): boolean {
    const rel = relative(this.rootPath, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
  }

  private resolveWorkspacePath(input: string): string {
    if (isAbsolute(input)) throw expectedToolError('invalid_argument', 'Workspace read paths must be relative.');
    const path = resolve(this.rootPath, input);
    this.assertInside(path);
    return path;
  }
}

type EntryIdentity = Readonly<{
  kind: 'filesystem-entry';
  canonicalPath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  device: string;
  inode: string;
  sizeBytes: number;
  mtimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
}>;


async function inspectHandle(
  handle: FileHandle,
  identity: EntryIdentity,
  signal: AbortSignal,
): Promise<Readonly<{ identity: EntryIdentity; digest: string; totalLines: number; sample: Uint8Array }>> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const sample = Buffer.alloc(Math.min(identity.sizeBytes, 8 * 1024));
  let sampleBytes = 0; let position = 0; let newlines = 0; let lastByte: number | undefined;
  while (position < identity.sizeBytes) {
    throwIfAborted(signal);
    const result = await handle.read(buffer, 0, Math.min(buffer.length, identity.sizeBytes - position), position);
    if (result.bytesRead === 0) break;
    const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk);
    for (const value of chunk) if (value === 0x0a) newlines += 1;
    lastByte = chunk[chunk.length - 1];
    if (sampleBytes < sample.length) {
      const count = Math.min(sample.length - sampleBytes, result.bytesRead); chunk.copy(sample, sampleBytes, 0, count); sampleBytes += count;
    }
    position += result.bytesRead;
  }
  if (position !== identity.sizeBytes) throw expectedToolError('conflict', 'The file changed while it was being read.');
  assertSameIdentity(await snapshotHandle(handle, identity.canonicalPath), identity);
  return Object.freeze({ identity, digest: `sha256:${hash.digest('hex')}`,
    totalLines: identity.sizeBytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1), sample: sample.subarray(0, sampleBytes) });
}

async function readSample(handle: FileHandle, totalBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const sample = Buffer.alloc(Math.min(totalBytes, 8 * 1024));
  const result = await handle.read(sample, 0, sample.length, 0);
  return sample.subarray(0, result.bytesRead);
}

type ReadRangeResult = Readonly<{
  bytesRead: number;
  range: PortableValue;
  encoding: 'utf-8' | 'base64';
  content: string;
  truncated: boolean;
  nextOffset?: number;
  nextLine?: number;
}>;

async function readByteRange(handle: FileHandle, offset: number, limit: number, total: number, signal: AbortSignal): Promise<ReadRangeResult> {
  throwIfAborted(signal);
  if (offset > total) throw expectedToolError('invalid_argument', 'offset exceeds the file length.');
  const buffer = Buffer.alloc(Math.min(limit, total - offset));
  const result = await handle.read(buffer, 0, buffer.length, offset);
  const nextOffset = offset + result.bytesRead;
  return Object.freeze({ bytesRead: result.bytesRead, range: { mode: 'byte', offset, length: result.bytesRead }, encoding: 'base64',
    content: buffer.subarray(0, result.bytesRead).toString('base64'), truncated: nextOffset < total, ...(nextOffset < total ? { nextOffset } : {}) });
}

async function readLineRange(
  handle: FileHandle,
  startLine: number,
  endLine: number,
  maxBytes: number,
  maxScanBytes: number,
  totalBytes: number,
  signal: AbortSignal,
): Promise<ReadRangeResult> {
  if (totalBytes === 0) {
    if (startLine > 1) throw expectedToolError('invalid_argument', 'startLine exceeds the file length.');
    return Object.freeze({ bytesRead: 0, range: { mode: 'line', startLine: 1, endLine: 0 }, encoding: 'utf-8', content: '', truncated: false });
  }
  const output: number[] = []; const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0; let currentLine = 1; let byteLimited = false; let lastByte: number | undefined;
  while (position < totalBytes && position < maxScanBytes && currentLine <= endLine && !byteLimited) {
    throwIfAborted(signal);
    const result = await handle.read(buffer, 0, Math.min(buffer.length, totalBytes - position, maxScanBytes - position), position);
    if (result.bytesRead === 0) break;
    const chunk = buffer.subarray(0, result.bytesRead);
    for (let index = 0; index < chunk.length; index += 1) {
      const value = chunk[index]!;
      lastByte = value;
      if (currentLine >= startLine && currentLine <= endLine) {
        if (output.length >= maxBytes) { byteLimited = true; break; }
        output.push(value);
      }
      if (value === 0x0a) currentLine += 1;
      position += 1;
      if (currentLine > endLine) break;
    }
  }
  if (currentLine < startLine && position >= maxScanBytes && position < totalBytes) {
    throw expectedToolError('limit', 'The requested line lies beyond maxScanBytes; raise the explicit scan limit or use byte mode.');
  }
  const knownLastLine = position >= totalBytes ? currentLine - (lastByte === 0x0a ? 1 : 0) : undefined;
  if (knownLastLine !== undefined && startLine > knownLastLine) throw expectedToolError('invalid_argument', 'startLine exceeds the file length.');
  let raw = Buffer.from(output);
  const scanLimitedMidLine = position >= maxScanBytes && position < totalBytes && lastByte !== 0x0a;
  if ((byteLimited || scanLimitedMidLine) && raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
    const newline = raw.lastIndexOf(0x0a);
    if (newline < 0) throw expectedToolError('limit', 'A requested line exceeds the read or scan limit; use byte mode.');
    raw = raw.subarray(0, newline + 1);
  }
  const decoded = decodeUtf8Prefix(raw);
  const newlineCount = raw.reduce((count, value) => count + (value === 0x0a ? 1 : 0), 0);
  const delivered = raw.length === 0 ? 0 : newlineCount + (raw[raw.length - 1] === 0x0a ? 0 : 1);
  const nextLine = startLine + delivered;
  const truncated = decoded.trimmed || byteLimited || scanLimitedMidLine || position < totalBytes;
  return Object.freeze({ bytesRead: decoded.bytes, range: { mode: 'line', startLine, endLine: Math.max(startLine, nextLine - 1) },
    encoding: 'utf-8', content: decoded.content, truncated, ...(truncated && delivered > 0 ? { nextLine } : {}) });
}

function decodeUtf8Prefix(bytes: Buffer): Readonly<{ content: string; bytes: number; trimmed: boolean }> {
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    try {
      const slice = bytes.subarray(0, bytes.length - trim);
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(slice), bytes: slice.length, trimmed: trim > 0 };
    } catch { /* try a shorter UTF-8 boundary */ }
  }
  throw expectedToolError('precondition', 'The requested line range is not valid UTF-8; use byte mode.');
}

async function snapshotEntry(path: string): Promise<EntryIdentity> {
  const info = await stat(path, { bigint: true }).catch((error) => { throw workspaceFilesystemError(error); });
  return identityFromStat(path, info);
}

async function snapshotHandle(handle: FileHandle, path: string): Promise<EntryIdentity> {
  return identityFromStat(path, await handle.stat({ bigint: true }));
}

function identityFromStat(path: string, info: BigIntStats): EntryIdentity {
  const sizeBytes = Number(info.size);
  if (!Number.isSafeInteger(sizeBytes)) throw expectedToolError('limit', 'The filesystem entry size is unsupported.');
  return Object.freeze({
    kind: 'filesystem-entry', canonicalPath: path,
    type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
    device: info.dev.toString(), inode: info.ino.toString(), sizeBytes, mtimeMs: Number(info.mtimeMs),
    mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString(),
  });
}

async function assertEntryIdentity(path: string, expected: EntryIdentity): Promise<void> {
  assertSameIdentity(await snapshotEntry(path), expected);
}

function assertSameIdentity(current: EntryIdentity, expected: EntryIdentity): void {
  if (!sameIdentity(current, expected)) throw expectedToolError('conflict', 'The prepared filesystem target changed.');
}

function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.type === right.type && left.sizeBytes === right.sizeBytes &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function entryIdentity(value: PortableValue): EntryIdentity {
  const record: Record<string, unknown> | undefined = isRecord(value)
    ? value
    : undefined;
  if (record === undefined || record.kind !== 'filesystem-entry' || typeof record.canonicalPath !== 'string' ||
    !['file', 'directory', 'symlink', 'other'].includes(String(record.type)) || typeof record.device !== 'string' ||
    typeof record.inode !== 'string' || typeof record.sizeBytes !== 'number' || typeof record.mtimeMs !== 'number' ||
    typeof record.mtimeNs !== 'string' || typeof record.ctimeNs !== 'string') {
    throw expectedToolError('precondition', 'The prepared filesystem identity is invalid.');
  }
  return value as unknown as EntryIdentity;
}

function makeIntent(
  context: ToolPrepareContext,
  value: Readonly<{
    input: Record<string, PortableValue>;
    targetIdentity: PortableValue;
    action: string;
    permission: AgentToolPermissionFacts;
    access: ToolAccess;
    recoveryClass: 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
    concurrency: 'read' | 'write' | 'exclusive';
    resourceKey: string;
  }>,
): PreparedToolIntent {
  return Object.freeze({
    input: Object.freeze(value.input), toolRevision: context.toolRevision, handlerRevision: context.handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION, targetIdentity: value.targetIdentity, generation: context.generation,
    action: { summary: value.action }, permission: value.permission, access: value.access, recoveryClass: value.recoveryClass,
    concurrency: value.concurrency, resourceKeys: [value.resourceKey], limits: context.limits,
  });
}

function readPermission(toolName: string, path: string, identity: EntryIdentity): AgentToolPermissionFacts {
  return Object.freeze({
    toolName, dangerLevel: 'safe', readonly: true, access: 'read', recoveryClass: 'read', actions: ['read'] as const, paths: [path], hosts: [],
    network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false,
    resolvedAddresses: [], targets: [identity],
  });
}

function mutationPermission(action: PatchAction, access: ToolAccess, binding: WorkspaceMutationBinding): AgentToolPermissionFacts {
  const destructive = action === 'delete';
  return Object.freeze({
    toolName: 'workspace_apply_patch', dangerLevel: destructive ? 'high' : 'medium', readonly: false, access,
    recoveryClass: 'transactional', actions: destructive ? ['delete'] as const : ['write'] as const, paths: [binding.canonicalPath], hosts: [],
    network: false, externalWrite: !binding.insideWorkspace, destructive, credentials: false, admin: false, unknownRisk: false,
    resolvedAddresses: [], targets: [binding as unknown as PortableValue],
  });
}

function availabilityPermission(): AgentToolPermissionFacts {
  return Object.freeze({
    toolName: 'workspace_apply_patch', dangerLevel: 'safe', readonly: true, access: 'read', recoveryClass: 'read',
    actions: ['read'] as const, paths: [], hosts: [], network: false, externalWrite: false, destructive: false,
    credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [],
  });
}

type PatchAction = 'create' | 'update' | 'delete';
type PatchEdit = WorkspacePatchEdit;

function patchAction(value: unknown): PatchAction {
  if (value === 'create' || value === 'update' || value === 'delete') return value;
  throw expectedToolError('invalid_argument', 'action must be create, update, or delete.');
}

function patchAccess(action: PatchAction, inside: boolean): ToolAccess {
  return action === 'delete' ? 'destructive' : inside ? 'write' : 'external';
}

function patchEdits(value: unknown): PatchEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATCH_EDITS) throw expectedToolError('invalid_argument', `edits must contain 1-${MAX_PATCH_EDITS} entries.`);
  let bytes = 0;
  return value.map((item) => {
    if (!isRecord(item) || typeof item.oldText !== 'string' || item.oldText.length === 0 || typeof item.newText !== 'string' ||
      (item.replaceAll !== undefined && typeof item.replaceAll !== 'boolean')) throw expectedToolError('invalid_argument', 'Each edit requires non-empty oldText and string newText.');
    bytes += Buffer.byteLength(item.oldText, 'utf8') + Buffer.byteLength(item.newText, 'utf8');
    if (bytes > MAX_PATCH_INPUT_BYTES) throw expectedToolError('limit', 'The patch input is too large.');
    return { oldText: item.oldText, newText: item.newText, replaceAll: item.replaceAll === true };
  });
}

function boundedContent(value: unknown): string {
  if (typeof value !== 'string') throw expectedToolError('invalid_argument', 'content is required for create.');
  if (Buffer.byteLength(value, 'utf8') > MAX_PATCH_INPUT_BYTES) throw expectedToolError('limit', 'The file content is too large.');
  return value;
}

function digestField(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw expectedToolError('invalid_argument', 'expectedDigest must come from workspace_read or workspace_search.');
  return value;
}

function readMode(value: unknown): 'auto' | 'line' | 'byte' {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'line' || value === 'byte') return value;
  throw expectedToolError('invalid_argument', 'mode must be auto, line, or byte.');
}

function searchMode(value: unknown): WorkspaceSearchMode {
  if (value === undefined) return 'literal';
  if (value === 'literal' || value === 'regex') return value;
  throw expectedToolError('invalid_argument', 'mode must be literal or regex.');
}

function binaryMode(value: unknown): WorkspaceBinaryMode {
  if (value === undefined) return 'exclude';
  if (value === 'exclude' || value === 'include') return value;
  throw expectedToolError('invalid_argument', 'binary must be exclude or include.');
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
]);

function contentKind(path: string, sample: Uint8Array): 'text' | 'image' | 'binary' {
  if (IMAGE_TYPES.has(extname(path).toLocaleLowerCase('en-US'))) return 'image';
  if (sample.includes(0)) return 'binary';
  try { new TextDecoder('utf-8', { fatal: true }).decode(sample); return 'text'; }
  catch { return 'binary'; }
}

function mediaType(path: string, kind: 'text' | 'image' | 'binary'): string {
  return kind === 'image' ? IMAGE_TYPES.get(extname(path).toLocaleLowerCase('en-US')) ?? 'application/octet-stream'
    : kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

function unavailableSearch(reason: string) {
  return { status: 'unavailable', summary: reason === 'ripgrep_not_found'
    ? 'Workspace search is unavailable because ripgrep is not installed on this host.' : 'Workspace search has no available backend on this host.',
  reason, matches: [], scannedFiles: 0, scannedBytes: 0, truncated: false, truncationReasons: [] } as const;
}

function unavailableList(reason: string) {
  return { status: 'unavailable', summary: 'Workspace directory listing requires a Host-native safe enumeration backend.', reason,
    entries: [], scannedEntries: 0, truncated: false, truncationReasons: [] } as const;
}

function unavailableMutation(action: PatchAction, canonicalPath: string, displayPath: string) {
  return { status: 'unavailable', summary: 'Conditional workspace mutation is unavailable on this Host filesystem.',
    reason: 'conditional_mutation_backend_unavailable', action, path: displayPath, canonicalPath } as const;
}

function mutationPayload(result: WorkspaceMutationResult) {
  return {
    status: result.status, summary: result.summary, action: result.action, path: result.displayPath, canonicalPath: result.canonicalPath,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.previousDigest === undefined ? {} : { previousDigest: result.previousDigest }),
    ...(result.digest === undefined ? {} : { digest: result.digest }),
    ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
    ...(result.replacements === undefined ? {} : { replacements: result.replacements }),
    ...(result.deleted === undefined ? {} : { deleted: result.deleted }),
    ...(result.identity === undefined ? {} : { identity: result.identity }),
  };
}

function mutationBinding(value: PortableValue): WorkspaceMutationBinding {
  const record = isRecord(value) ? value as Record<string, unknown> : undefined;
  if (record === undefined || record.protocol !== 'workspace-mutation-binding.v1' || typeof record.adapterRevision !== 'string' ||
    !['create', 'update', 'delete'].includes(String(record.action)) || typeof record.canonicalPath !== 'string' ||
    typeof record.displayPath !== 'string' || typeof record.insideWorkspace !== 'boolean' || typeof record.entryName !== 'string' ||
    typeof record.transactionName !== 'string' || typeof record.temporaryName !== 'string' || typeof record.backupName !== 'string' ||
    record.parentToken === undefined || record.parentIdentity === undefined) {
    throw expectedToolError('precondition', 'The prepared workspace mutation binding is invalid.');
  }
  return value as unknown as WorkspaceMutationBinding;
}

async function revalidateFileIdentity(identity: EntryIdentity, signal: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  let handle: FileHandle | undefined;
  try {
    handle = await open(identity.canonicalPath, 'r');
    return sameIdentity(await snapshotHandle(handle, identity.canonicalPath), identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

function cursorBinding(kind: string, value: PortableValue): string {
  return createHash('sha256').update(`${kind}\0${canonicalJson(value)}`).digest('hex');
}

function encodeCursor(kind: 'list' | 'search', binding: string, after: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, kind, binding, after }), 'utf8').toString('base64url');
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `workspace-cursor.v1.${payload}.${digest}`;
}

function decodeCursor(cursor: string | undefined, kind: 'list' | 'search', binding: string): string | undefined {
  if (cursor === undefined) return undefined;
  const match = /^workspace-cursor\.v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{32})$/u.exec(cursor);
  if (match === null || createHash('sha256').update(match[1]!).digest('hex').slice(0, 32) !== match[2]) {
    throw expectedToolError('invalid_argument', 'The workspace cursor is invalid.');
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); }
  catch { throw expectedToolError('invalid_argument', 'The workspace cursor is invalid.'); }
  if (!isRecord(value) || value.version !== 1 || value.kind !== kind || value.binding !== binding || typeof value.after !== 'string') {
    throw expectedToolError('invalid_argument', 'The workspace cursor does not match this request.');
  }
  return value.after;
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, PortableValue>;
  return `{${Object.keys(record).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`;
}

function handlerRevision(options: WorkspaceToolOptions, name: WorkspaceBaseToolName): string {
  return options.handlerRevisions?.[name] ?? `${name}.handler.v1`;
}

function invocationOwner(context: ToolPrepareContext): string {
  return createHash('sha256').update(`${context.hostId}\0${context.sessionId}\0${context.runId}`).digest('hex');
}

function revisionReference(toolName: string, toolRevision: string, handlerRevision: string) {
  return Object.freeze({ toolName, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION });
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\u0000')) {
    throw expectedToolError('invalid_argument', `${label} must contain 1-${maximum} bounded characters.`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw expectedToolError('invalid_argument', `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw expectedToolError('invalid_argument', `${label} must be boolean.`);
  return value;
}

function stringArray(value: unknown, label: string, maximumItems: number, maximumChars: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw expectedToolError('invalid_argument', `${label} has too many entries.`);
  return value.map((item) => boundedString(item, label, maximumChars));
}

function stringField(input: Readonly<Record<string, PortableValue>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw expectedToolError('precondition', `Prepared ${key} is invalid.`);
  return value;
}

function optionalStringField(input: Readonly<Record<string, PortableValue>>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw expectedToolError('precondition', `Prepared ${key} is invalid.`);
  return value;
}

function numberField(input: Readonly<Record<string, PortableValue>>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw expectedToolError('precondition', `Prepared ${key} is invalid.`);
  return value;
}

function booleanField(input: Readonly<Record<string, PortableValue>>, key: string): boolean {
  const value = input[key];
  if (typeof value !== 'boolean') throw expectedToolError('precondition', `Prepared ${key} is invalid.`);
  return value;
}

function requiredField(input: Readonly<Record<string, PortableValue>>, key: string): PortableValue {
  const value = input[key];
  if (value === undefined) throw expectedToolError('precondition', `Prepared ${key} is invalid.`);
  return value;
}

function workspaceFilesystemError(error: unknown): Error {
  if (error instanceof Error && error.name === 'ToolExecutionError') return error;
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT': return expectedToolError('not_found', 'The requested filesystem resource was not found.');
    case 'EEXIST': return expectedToolError('conflict', 'The filesystem resource already exists.');
    case 'ENOTEMPTY': return expectedToolError('conflict', 'The directory is not empty.');
    case 'ENOTDIR': case 'EISDIR': return expectedToolError('precondition', 'The path has the wrong resource type.');
    case 'EACCES': case 'EPERM': case 'EROFS': return expectedToolError('precondition', 'The filesystem operation is not permitted.');
    case 'ENOSPC': return expectedToolError('limit', 'The filesystem has insufficient storage capacity.');
    default: return error instanceof Error ? error : new Error('Unknown workspace filesystem failure.');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Workspace invocation was cancelled.'); error.name = 'AbortError'; throw error;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
