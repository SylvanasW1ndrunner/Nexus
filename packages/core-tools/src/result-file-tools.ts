import {
  PREPARED_TOOL_INTENT_REVISION,
  ContentReferenceError,
  expectedToolError,
  parseContentReference,
  type AgentArtifactStore,
  type AgentToolPermissionFacts,
  type OpenedContent,
  type PreparedToolIntent,
  type ToolExecuteContext,
  type ToolInvocationContribution,
  type ToolPrepareContext,
  type ToolTargetRevalidator,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import {
  RESULT_FILE_MAX_BYTES,
  type ResultMaterializationStore,
} from './result-materialization-store.js';
import {
  assertNoReplaceWorkspaceMutationAdapter,
  type WorkspaceMutationAdapter,
  type WorkspaceMutationBinding,
  type WorkspaceMutationResult,
} from './workspace-mutation-adapter.js';

const MAX_PATH_CHARS = 4_096;
const MATERIALIZE_REVISION = 'result_materialize.v1';
const SAVE_REVISION = 'result_save.v1';
const MATERIALIZE_HANDLER_REVISION = 'result_materialize.handler.v1';
const SAVE_HANDLER_REVISION = 'result_save.handler.v1';
const LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 64 * 1024,
  maxArtifactBytes: RESULT_FILE_MAX_BYTES,
  maxDepth: 12,
  maxRecords: 256,
});

export type ResultMaterializeToolOptions = Readonly<{
  artifactStore?: Pick<AgentArtifactStore, 'openContent'>;
  materializationStore?: ResultMaterializationStore;
  handlerRevision?: string;
}>;

export type ResultSaveToolOptions = Readonly<{
  rootPath: string;
  artifactStore?: Pick<AgentArtifactStore, 'openContent'>;
  mutationAdapter?: WorkspaceMutationAdapter | null;
  handlerRevision?: string;
}>;

export function createResultMaterializeToolContribution(
  options: ResultMaterializeToolOptions,
): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? MATERIALIZE_HANDLER_REVISION;
  return Object.freeze({
    definition: {
      name: 'result_materialize',
      description: 'Materialize complete Runtime-owned content as a Run-scoped temporary file for Python, Shell, or another local Tool. The Runtime deletes it after the Run; use result_save only when the user explicitly requests a persistent file.',
      aliases: [],
      tags: ['result', 'content', 'temporary', 'file'],
      inputSchema: {
        type: 'object',
        properties: { contentRef: { type: 'string' } },
        required: ['contentRef'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] },
          summary: { type: 'string' },
          reason: { type: 'string' },
          contentRef: { type: 'string' },
          temporaryPath: { type: 'string' },
          contentType: { type: 'string' },
          sizeBytes: { type: 'integer', minimum: 0 },
          digest: { type: 'string' },
          lifecycle: { type: 'string', enum: ['run'] },
        },
        required: ['status', 'summary'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'runtime',
      exposure: 'direct',
      permission: { actions: ['read'] },
      access: 'read',
      recoveryClass: 'read',
      limits: LIMITS,
      toolRevision: MATERIALIZE_REVISION,
      handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'result', preparingMessage: '正在准备临时结果文件。' },
    },
    runtime: {
      revision: revision('result_materialize', MATERIALIZE_REVISION, handlerRevision),
      prepare(input, context) {
        const contentRef = contentReference(input.contentRef);
        return intent(context, {
          input: { contentRef },
          targetIdentity: null,
          action: 'Materialize Runtime content for temporary use by this Run.',
          permission: runtimeReadPermission('result_materialize', contentRef),
          access: 'read',
          recoveryClass: 'read',
          concurrency: 'read',
          resourceKeys: [`content:${contentRef}`, `materialized-run:${context.runId}`],
        });
      },
      async execute(input, context) {
        if (options.artifactStore === undefined || options.materializationStore === undefined) {
          return unavailable('Runtime result materialization is unavailable on this host.');
        }
        try {
          const contentRef = contentReference(input.contentRef);
          const opened = await openContent(options.artifactStore, contentRef, context);
          return {
            status: 'ok',
            summary: 'Runtime content materialized for temporary use by this Run.',
            ...await options.materializationStore.materialize({
              opened,
              owner: accessScope(context),
              signal: context.signal,
              deadline: context.deadline,
            }),
          };
        } catch (error) {
          throw mapContentError(error, 'Runtime result materialization failed.');
        }
      },
    },
  } satisfies ToolInvocationContribution);
}

export function createResultSaveToolContribution(
  options: ResultSaveToolOptions,
): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? SAVE_HANDLER_REVISION;
  const adapter = options.mutationAdapter ?? null;
  if (adapter !== null) assertNoReplaceWorkspaceMutationAdapter(adapter);
  return Object.freeze({
    definition: {
      name: 'result_save',
      description: 'Persist complete Runtime-owned content as a new workspace file without conversion or overwrite. Call only when the user explicitly asks to save, export, retain, or generate the result as a durable file.',
      aliases: [],
      tags: ['result', 'content', 'workspace', 'file', 'export'],
      inputSchema: {
        type: 'object',
        properties: {
          contentRef: { type: 'string' },
          path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARS },
        },
        required: ['contentRef', 'path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] },
          summary: { type: 'string' },
          reason: { type: 'string' },
          contentRef: { type: 'string' },
          path: { type: 'string' },
          canonicalPath: { type: 'string' },
          contentType: { type: 'string' },
          sizeBytes: { type: 'integer', minimum: 0 },
          digest: { type: 'string' },
          lifecycle: { type: 'string', enum: ['persistent'] },
        },
        required: ['status', 'summary'],
        additionalProperties: false,
      },
      dangerLevel: 'medium',
      readonly: false,
      source: 'runtime',
      exposure: 'direct',
      permission: { actions: ['write'] },
      access: 'write',
      recoveryClass: 'transactional',
      limits: LIMITS,
      toolRevision: SAVE_REVISION,
      handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'write', timeoutMs: LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: {
        category: 'file',
        preparingMessage: '正在保存结果文件。',
        inputPreview: { argument: 'path', label: 'Path' },
      },
    },
    runtime: {
      revision: revision('result_save', SAVE_REVISION, handlerRevision),
      async prepare(input, context) {
        const contentRef = contentReference(input.contentRef);
        const requestedPath = requiredText(input.path, 'path', MAX_PATH_CHARS);
        if (adapter === null || options.artifactStore === undefined) {
          return intent(context, {
            input: { contentRef, requestedPath, unavailableReason: 'workspace_mutation_unavailable' },
            targetIdentity: null,
            action: 'Check whether persistent Runtime result saving is available.',
            permission: runtimeReadPermission('result_save', contentRef),
            access: 'read',
            recoveryClass: 'read',
            concurrency: 'read',
            resourceKeys: ['workspace:result-save-availability'],
          });
        }
        let opened: OpenedContent | undefined;
        try {
          opened = await options.artifactStore.openContent({
            contentRef,
            access: accessScope(context),
            signal: context.signal,
          });
          if (opened.byteSize > RESULT_FILE_MAX_BYTES) {
            throw expectedToolError('limit', 'The Runtime result exceeds the 64 MiB persistent save limit.');
          }
        } catch (error) {
          throw mapContentError(error, 'Persistent Runtime result preparation failed.');
        } finally {
          await opened?.stream.cancel().catch(() => undefined);
        }
        const metadata = contentMetadata(opened);
        const binding = await adapter.prepare({
          rootPath: options.rootPath,
          requestedPath,
          action: 'create',
          transactionKey: `${context.invocationId}:${context.idempotencyKey}`,
          signal: context.signal,
        });
        if (!binding.insideWorkspace) {
          throw expectedToolError('invalid_argument', 'result_save only creates files inside the project workspace.');
        }
        return intent(context, {
          input: {
            contentRef,
            requestedPath,
            binding,
            ...metadata,
          },
          targetIdentity: binding,
          action: `Save Runtime content as new workspace file ${binding.canonicalPath}.`,
          permission: workspaceWritePermission(binding),
          access: 'write',
          recoveryClass: 'transactional',
          concurrency: 'write',
          resourceKeys: [`content:${contentRef}`, `workspace:${binding.canonicalPath}`],
        });
      },
      async execute(input, context) {
        if (input.unavailableReason !== undefined || adapter === null || options.artifactStore === undefined) {
          return unavailable('Persistent Runtime result saving is unavailable on this host.');
        }
        const binding = mutationBinding(input.binding);
        const validation = await adapter.revalidate(binding, context.signal);
        if (validation !== undefined) {
          throw expectedToolError('conflict', 'The prepared result-save target changed before execution.');
        }
        let opened: OpenedContent | undefined;
        try {
          const contentRef = contentReference(input.contentRef);
          opened = await openContent(options.artifactStore, contentRef, context);
          assertOpenedMetadata(opened, preparedContentMetadata(input));
          if (opened.byteSize > RESULT_FILE_MAX_BYTES) {
            throw expectedToolError('limit', 'The Runtime result exceeds the 64 MiB persistent save limit.');
          }
          const result = await adapter.execute(binding, {
            desiredSource: opened.stream,
            maxSourceBytes: RESULT_FILE_MAX_BYTES,
            signal: context.signal,
            deadline: context.deadline,
          });
          return persistentPayload(
            contentRef,
            requiredText(input.requestedPath, 'requestedPath', MAX_PATH_CHARS),
            preparedContentMetadata(input),
            result,
          );
        } catch (error) {
          throw mapContentError(error, 'Persistent Runtime result saving failed.');
        } finally {
          await opened?.stream.cancel().catch(() => undefined);
        }
      },
      async recover(input, context) {
        if (input.unavailableReason !== undefined || adapter === null) {
          return unavailable('Persistent Runtime result saving is unavailable on this host.');
        }
        const binding = mutationBinding(input.binding);
        try {
          const contentRef = contentReference(input.contentRef);
          const result = await adapter.recover(binding, context.signal);
          return persistentPayload(
            contentRef,
            requiredText(input.requestedPath, 'requestedPath', MAX_PATH_CHARS),
            preparedContentMetadata(input),
            result,
          );
        } catch (error) {
          throw mapContentError(error, 'Persistent Runtime result recovery failed.');
        }
      },
    },
  } satisfies ToolInvocationContribution);
}

/** Host-level prepared-target revalidation for `result_save`. */
export function createResultSaveTargetRevalidator(
  adapter: WorkspaceMutationAdapter,
): ToolTargetRevalidator {
  assertNoReplaceWorkspaceMutationAdapter(adapter);
  return async (prepared, context) => {
    if (prepared.permission.toolName !== 'result_save') return;
    const binding = mutationBinding(prepared.targetIdentity);
    if (binding.adapterRevision !== adapter.revision || !binding.insideWorkspace || binding.action !== 'create') {
      return 'target_changed';
    }
    return await adapter.revalidate(binding, context.signal);
  };
}

function intent(
  context: ToolPrepareContext,
  value: Readonly<{
    input: Record<string, PortableValue>;
    targetIdentity: PortableValue;
    action: string;
    permission: AgentToolPermissionFacts;
    access: 'read' | 'write';
    recoveryClass: 'read' | 'transactional';
    concurrency: 'read' | 'write';
    resourceKeys: readonly string[];
  }>,
): PreparedToolIntent {
  return Object.freeze({
    input: Object.freeze(value.input),
    toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    targetIdentity: value.targetIdentity,
    generation: context.generation,
    action: { summary: value.action },
    permission: value.permission,
    access: value.access,
    recoveryClass: value.recoveryClass,
    concurrency: value.concurrency,
    resourceKeys: Object.freeze([...value.resourceKeys]),
    limits: context.limits,
  });
}

function revision(toolName: string, toolRevision: string, handlerRevision: string) {
  return Object.freeze({
    toolName,
    toolRevision,
    handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
  });
}

function accessScope(context: Pick<ToolExecuteContext, 'hostId' | 'projectId' | 'sessionId' | 'runId'>) {
  return Object.freeze({
    hostId: context.hostId,
    projectId: context.projectId,
    sessionId: context.sessionId,
    runId: context.runId,
  });
}

function openContent(
  store: Pick<AgentArtifactStore, 'openContent'>,
  contentRef: string,
  context: ToolExecuteContext,
): Promise<OpenedContent> {
  return store.openContent({
    contentRef,
    access: accessScope(context),
    signal: context.signal,
    deadline: context.deadline,
  });
}

function runtimeReadPermission(toolName: string, contentRef: string): AgentToolPermissionFacts {
  return Object.freeze({
    toolName,
    dangerLevel: 'safe',
    readonly: true,
    access: 'read',
    recoveryClass: 'read',
    actions: ['read'] as const,
    paths: [],
    hosts: [],
    network: false,
    externalWrite: false,
    destructive: false,
    credentials: false,
    admin: false,
    unknownRisk: false,
    resolvedAddresses: [],
    targets: [{ kind: 'runtime-content', contentRef }],
  });
}

function workspaceWritePermission(binding: WorkspaceMutationBinding): AgentToolPermissionFacts {
  return Object.freeze({
    toolName: 'result_save',
    dangerLevel: 'medium',
    readonly: false,
    access: 'write',
    recoveryClass: 'transactional',
    actions: ['write'] as const,
    paths: [binding.canonicalPath],
    hosts: [],
    network: false,
    externalWrite: false,
    destructive: false,
    credentials: false,
    admin: false,
    unknownRisk: false,
    resolvedAddresses: [],
    targets: [binding],
  });
}

function persistentPayload(
  contentRef: string,
  requestedPath: string,
  metadata: PreparedContentMetadata,
  result: WorkspaceMutationResult,
) {
  const expectedDigest = `sha256:${metadata.contentChecksum}`;
  if (result.status !== 'ok' || result.action !== 'create' || result.deleted === true ||
    result.digest !== expectedDigest || result.sizeBytes !== metadata.contentByteSize) {
    throw expectedToolError('external', 'The saved Runtime result could not be verified.', {
      outcome: 'unknown',
    });
  }
  return Object.freeze({
    status: 'ok',
    summary: `Runtime content saved as ${result.displayPath}.`,
    contentRef,
    path: requestedPath,
    canonicalPath: result.canonicalPath,
    contentType: metadata.contentType,
    sizeBytes: metadata.contentByteSize,
    digest: expectedDigest,
    lifecycle: 'persistent',
  });
}

type PreparedContentMetadata = Readonly<{
  contentType: string;
  contentByteSize: number;
  contentChecksum: string;
}>;

function contentMetadata(opened: OpenedContent): PreparedContentMetadata {
  if (opened.contentType.length < 1 || opened.contentType.length > 1_024 ||
    !Number.isSafeInteger(opened.byteSize) || opened.byteSize < 0 ||
    opened.byteSize > RESULT_FILE_MAX_BYTES) {
    throw expectedToolError('precondition', 'Runtime content metadata is invalid.');
  }
  return Object.freeze({
    contentType: opened.contentType,
    contentByteSize: opened.byteSize,
    contentChecksum: normalizeChecksum(opened.checksum),
  });
}

function preparedContentMetadata(input: Readonly<Record<string, PortableValue>>): PreparedContentMetadata {
  if (typeof input.contentType !== 'string' || input.contentType.length < 1 || input.contentType.length > 1_024 ||
    typeof input.contentByteSize !== 'number' || !Number.isSafeInteger(input.contentByteSize) ||
    input.contentByteSize < 0 || input.contentByteSize > RESULT_FILE_MAX_BYTES ||
    typeof input.contentChecksum !== 'string') {
    throw expectedToolError('precondition', 'Prepared Runtime content metadata is invalid.');
  }
  return Object.freeze({
    contentType: input.contentType,
    contentByteSize: input.contentByteSize,
    contentChecksum: normalizeChecksum(input.contentChecksum),
  });
}

function assertOpenedMetadata(opened: OpenedContent, expected: PreparedContentMetadata): void {
  const actual = contentMetadata(opened);
  if (actual.contentType !== expected.contentType || actual.contentByteSize !== expected.contentByteSize ||
    actual.contentChecksum !== expected.contentChecksum) {
    throw expectedToolError('conflict', 'Runtime content metadata changed after result-save preparation.');
  }
}

function mutationBinding(value: PortableValue | undefined): WorkspaceMutationBinding {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') {
    throw expectedToolError('precondition', 'The prepared result-save target is invalid.');
  }
  const candidate = value as unknown as Partial<WorkspaceMutationBinding>;
  if (candidate.protocol !== 'workspace-mutation-binding.v1' ||
    candidate.action !== 'create' || typeof candidate.adapterRevision !== 'string' ||
    typeof candidate.canonicalPath !== 'string' || typeof candidate.displayPath !== 'string' ||
    candidate.insideWorkspace !== true || typeof candidate.entryName !== 'string' ||
    typeof candidate.transactionName !== 'string' || typeof candidate.temporaryName !== 'string' ||
    typeof candidate.backupName !== 'string' || candidate.parentToken === undefined ||
    candidate.parentIdentity === undefined) {
    throw expectedToolError('precondition', 'The prepared result-save target is invalid.');
  }
  return value as unknown as WorkspaceMutationBinding;
}

function contentReference(value: PortableValue | undefined): string {
  try {
    return parseContentReference(requiredText(value, 'contentRef', 256)).contentRef;
  } catch (error) {
    throw mapContentError(error, 'The Runtime content reference is invalid.');
  }
}

function requiredText(value: PortableValue | undefined, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || value.includes('\0')) {
    throw expectedToolError('invalid_argument', `${label} must be a non-empty bounded string.`);
  }
  return value;
}

function normalizeChecksum(value: string): string {
  const match = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value);
  if (match === null) throw expectedToolError('precondition', 'Runtime content checksum is invalid.');
  return match[1]!;
}

function unavailable(summary: string) {
  return Object.freeze({ status: 'unavailable', summary, reason: 'result_file_backend_unavailable' });
}

function mapContentError(error: unknown, fallback: string): Error {
  if (!(error instanceof ContentReferenceError)) {
    return error instanceof Error ? error : new Error(fallback);
  }
  switch (error.code) {
    case 'invalid_cursor':
      return expectedToolError('invalid_cursor', error.message);
    case 'invalid_reference':
    case 'type_mismatch':
      return expectedToolError('invalid_argument', error.message);
    case 'not_found':
      return expectedToolError('not_found', error.message);
    case 'forbidden':
      return expectedToolError('precondition', 'The content reference is outside this Run owner scope.');
    case 'expired':
      return expectedToolError('precondition', error.message);
    case 'limit':
      return expectedToolError('limit', error.message);
  }
}
