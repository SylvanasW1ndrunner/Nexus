import {
  PREPARED_TOOL_INTENT_REVISION,
  ContentReferenceError,
  RESULT_READ_STRUCTURE_BUDGET,
  assertResultReadOutputBudget,
  expectedToolError,
  parseContentReference,
  resolveContentOffset,
  type AgentArtifactStore,
  type ContentReadMode,
  type ToolInvocationContribution,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';

const TOOL_REVISION = 'result_read.v1';
const DEFAULT_HANDLER_REVISION = 'result_read.handler.v3';
const DEFAULT_RECORD_LIMIT = 40;

export type ResultReadToolOptions = Readonly<{
  artifactStore?: Pick<AgentArtifactStore, 'readContent'>;
  handlerRevision?: string;
}>;

export function createResultReadToolContribution(
  options: ResultReadToolOptions,
): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? DEFAULT_HANDLER_REVISION;
  const revision = Object.freeze({
    toolName: 'result_read',
    toolRevision: TOOL_REVISION,
    handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
  });
  return Object.freeze({
    definition: {
      name: 'result_read',
      description: 'Read a bounded page from Runtime-owned content using an owner-scoped cursor. Record mode defaults to 40 items; when eof is false, continue with the returned nextCursor.',
      aliases: [],
      tags: ['result', 'content', 'cursor'],
      inputSchema: {
        type: 'object',
        properties: {
          contentRef: { type: 'string' },
          cursor: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
          mode: { type: 'string', enum: ['text', 'line', 'record', 'byte'] },
        },
        required: ['contentRef'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] },
          summary: { type: 'string' },
          contentRef: { type: 'string' },
          mode: { type: 'string', enum: ['text', 'line', 'record', 'byte'] },
          contentType: { type: 'string' },
          totalBytes: { type: 'integer', minimum: 0 },
          offset: { type: 'integer', minimum: 0 },
          preview: { type: 'string' },
          eof: { type: 'boolean' },
          nextCursor: { type: 'string' },
          data: { oneOf: [{ type: 'string' }, { type: 'array' }] },
          encoding: { type: 'string', enum: ['utf-8', 'base64'] },
          reason: { type: 'string' },
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
      limits: {
        timeoutMs: 30_000,
        maxInputBytes: 16 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxArtifactBytes: 64 * 1024 * 1024,
        maxDepth: RESULT_READ_STRUCTURE_BUDGET.maxDepth,
        maxRecords: RESULT_READ_STRUCTURE_BUDGET.maxRecords,
      },
      toolRevision: TOOL_REVISION,
      handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'read', timeoutMs: 30_000 },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'result', preparingMessage: '正在读取结果内容。' },
    },
    runtime: {
      revision,
      prepare(input, context) {
        try {
        const contentRef = requireString(input.contentRef, 'contentRef');
        parseContentReference(contentRef);
        const mode = readMode(input.mode);
        const limit = readLimit(input.limit, mode);
        const cursor = optionalString(input.cursor, 'cursor');
        const offset = optionalOffset(input.offset);
        const resolvedOffset = resolveContentOffset({
          contentRef,
          mode,
          ...(cursor === undefined ? {} : { cursor }),
          ...(offset === undefined ? {} : { offset }),
        });
        const preparedInput: Record<string, PortableValue> = {
          contentRef,
          mode,
          limit,
          ...(cursor === undefined ? { offset: resolvedOffset } : { cursor }),
        };
        return Object.freeze({
          input: Object.freeze(preparedInput),
          toolRevision: context.toolRevision,
          handlerRevision: context.handlerRevision,
          intentRevision: PREPARED_TOOL_INTENT_REVISION,
          // Runtime-owned immutable content is resolved and ACL-checked by the
          // Artifact Store itself; it has no external mutable target to revalidate.
          targetIdentity: null,
          generation: context.generation,
          action: { summary: `Read ${mode} content from a Runtime result.` },
          permission: {
            toolName: 'result_read', dangerLevel: 'safe' as const, readonly: true,
            access: 'read' as const, recoveryClass: 'read' as const,
            actions: ['read'] as const, paths: [], hosts: [],
            network: false, externalWrite: false, destructive: false, credentials: false,
            admin: false, unknownRisk: false, resolvedAddresses: [],
            targets: [{ kind: 'runtime-content', contentRef }],
          },
          access: 'read',
          recoveryClass: 'read',
          concurrency: 'read',
          resourceKeys: [`content:${contentRef}`],
          limits: context.limits,
        });
        } catch (error) { throw mapContentError(error); }
      },
      async execute(input, context) {
        if (options.artifactStore === undefined) {
          return {
            status: 'unavailable',
            summary: 'Runtime result storage is unavailable on this host.',
            reason: 'artifact_store_unavailable',
          };
        }
        try {
          const cursor = optionalString(input.cursor, 'cursor');
          const result = await options.artifactStore.readContent({
            contentRef: requireString(input.contentRef, 'contentRef'),
            mode: readMode(input.mode),
            limit: readLimit(input.limit, readMode(input.mode)),
            ...(cursor === undefined
              ? { offset: optionalOffset(input.offset) ?? 0 }
              : { cursor }),
            access: {
              hostId: context.hostId,
              projectId: context.projectId,
              sessionId: context.sessionId,
              runId: context.runId,
            },
            signal: context.signal,
            deadline: context.deadline,
          });
          // `data` is the authoritative bounded page. The Store-level preview is
          // derived from the same bytes and would make the Runtime project the
          // page twice before the model can consume it.
          const { preview: redundantPreview, ...page } = result;
          void redundantPreview;
          if (!page.eof && page.nextCursor === undefined) {
            throw new ContentReferenceError('invalid_cursor', 'A non-final Runtime content page must include nextCursor.');
          }
          const summary = page.eof
            ? 'Runtime content page read.'
            : `Runtime content page read. Continue with nextCursor: ${page.nextCursor}.`;
          const payload = {
            status: 'ok',
            summary,
            contentRef: page.contentRef,
            mode: page.mode,
            contentType: page.contentType,
            totalBytes: page.totalBytes,
            offset: page.offset,
            eof: page.eof,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            ...(page.encoding === undefined ? {} : { encoding: page.encoding }),
            data: page.data,
          };
          assertResultReadOutputBudget(payload);
          return payload;
        } catch (error) {
          throw mapContentError(error);
        }
      },
    },
  } satisfies ToolInvocationContribution);
}

function requireString(value: PortableValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw expectedToolError('invalid_argument', `${label} is required.`);
  }
  return value;
}

function optionalString(value: PortableValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw expectedToolError(label === 'cursor' ? 'invalid_cursor' : 'invalid_argument', `${label} is invalid.`);
  }
  return value;
}

function optionalOffset(value: PortableValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw expectedToolError('invalid_cursor', 'offset must be a non-negative integer.');
  }
  return value;
}

function readMode(value: PortableValue | undefined): ContentReadMode {
  if (value === undefined) return 'text';
  if (value === 'text' || value === 'line' || value === 'record' || value === 'byte') return value;
  throw expectedToolError('invalid_argument', 'mode must be text, line, record, or byte.');
}

function readLimit(value: PortableValue | undefined, mode: ContentReadMode): number {
  const fallback = mode === 'record'
    ? DEFAULT_RECORD_LIMIT
    : mode === 'line'
      ? RESULT_READ_STRUCTURE_BUDGET.defaultItems
      : 64 * 1024;
  if (value === undefined) return fallback;
  const maximum = mode === 'record' ? RESULT_READ_STRUCTURE_BUDGET.maxRecordItems
    : mode === 'line' ? RESULT_READ_STRUCTURE_BUDGET.maxLineItems : 1_048_576;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw expectedToolError('invalid_argument', `limit must be between 1 and ${maximum}.`);
  }
  return value;
}

function mapContentError(error: unknown): Error {
  if (!(error instanceof ContentReferenceError)) return error instanceof Error ? error : new Error('Content read failed.');
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
