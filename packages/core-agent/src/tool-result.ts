import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { PortableValue } from '@dbagent/shared';
import type {
  AgentToolResultEnvelope,
} from './types.js';
import type { InvocationLimits } from './tools/tool-protocol.js';
import { invalidToolResultError, ToolExecutionError } from './tools/tool-errors.js';

const LEGACY_AGENT_TOOL_RESULT_ENVELOPE = 'schemanaut.agent-tool-result.v1';
const MAX_OBSERVATION_SUMMARY_CHARS = 128;
const MAX_SYNC_HANDLER_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_HANDLER_STRING_BYTES = 1024 * 1024;
const schemaValidators = new Map<string, ReturnType<Ajv2020['compile']>>();
const ajv = new Ajv2020({ allErrors: true, strict: false });

export type RuntimeProvenance = Readonly<{
  issuer: 'runtime';
  hostId: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: string;
  source: string;
  sourceId?: string;
  generation: string;
}>;

export type ToolResultProjectionBudget = Readonly<{
  maxTokens: number;
  estimateTokens(text: string): number;
}>;

export type ToolObservation = Readonly<{
  status: 'ok' | 'partial' | 'unavailable';
  summary: string;
  preview?: string;
  contentRef?: string;
  contentType?: string;
  totalBytes?: number;
  truncated: boolean;
  nextCursor?: string;
  provenance: RuntimeProvenance;
}>;

export type NormalizedToolResult = Readonly<{
  payload: PortableValue;
  status: ToolObservation['status'];
  summary: string;
  preview: string;
  provenance: RuntimeProvenance;
  contentType: string;
  artifactBytes?: Uint8Array;
  totalBytes: number;
}>;

export type MaterializedToolResult = Readonly<{
  observation: ToolObservation;
  modelProjection: PortableValue;
  userProjection: PortableValue;
  durableSummary: PortableValue;
  evidenceRefs: string[];
}>;

export type RetainedToolResultContent = Readonly<{
  contentType: string;
  totalBytes: number;
}>;

function isAgentToolResultEnvelope(value: unknown): value is AgentToolResultEnvelope {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value as { type?: unknown }).type === LEGACY_AGENT_TOOL_RESULT_ENVELOPE &&
    Object.hasOwn(value, 'modelProjection') && Object.hasOwn(value, 'durableSummary');
}

/** Runtime-only normalization boundary for untrusted Handler payloads. */
export function normalizeAgentToolResult(
  value: unknown,
  options: Readonly<{
    outputSchema: Readonly<Record<string, unknown>>;
    limits: InvocationLimits;
    provenance: RuntimeProvenance;
    contentType?: string;
    projectionBudget?: ToolResultProjectionBudget;
    signal?: AbortSignal;
    deadline?: string;
    now?: () => number;
  }>,
): NormalizedToolResult {
  assertResultActive(options);
  const hardBytes = Math.min(options.limits.maxArtifactBytes, MAX_SYNC_HANDLER_PAYLOAD_BYTES);
  const payload = boundedPortableClone(value, options.limits.maxDepth, options.limits.maxRecords, hardBytes, options);
  if (isAgentToolResultEnvelope(payload)) throw invalidToolResultError();
  assertResultActive(options);
  const validator = outputValidator(options.outputSchema);
  if (!validator(payload)) throw invalidToolResultError();
  assertResultActive(options);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.byteLength > hardBytes) throw invalidToolResultError();
  assertResultActive(options);
  const status = payloadStatus(payload);
  let summary = payloadSummary(payload);
  const contentType = options.contentType ?? 'application/json';
  const artifact = encoded.byteLength > options.limits.maxOutputBytes;
  const projectionBudget = options.projectionBudget ?? conservativeProjectionBudget();
  const observationBase = (candidateSummary: string): Omit<ToolObservation, 'preview'> => ({
    status: artifact && status === 'ok' ? 'partial' : status,
    summary: candidateSummary,
    contentType,
    totalBytes: encoded.byteLength,
    truncated: artifact,
    provenance: options.provenance,
    ...(artifact ? {
      contentRef: 'x'.repeat(256),
    } : {}),
  });
  summary = fitObservationSummary(summary, projectionBudget, observationBase);
  const preview = payloadPreview(
    encoded,
    projectionBudget,
    observationBase(summary),
  );
  return Object.freeze({
    payload,
    status,
    summary,
    preview,
    provenance: Object.freeze(structuredClone(options.provenance)),
    contentType,
    ...(artifact ? { artifactBytes: encoded } : {}),
    totalBytes: encoded.byteLength,
  });
}

function fitObservationSummary(
  summary: string,
  budget: ToolResultProjectionBudget,
  observation: (summary: string) => Omit<ToolObservation, 'preview'>,
): string {
  const maxTokens = projectionTokenLimit(budget);
  if (observationTokens(budget, observation(summary), '') <= maxTokens) return summary;
  let low = 0;
  let high = summary.length;
  let best = '';
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = summary.slice(0, length);
    if (observationTokens(budget, observation(candidate), '') <= maxTokens) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (observationTokens(budget, observation(best), '') > maxTokens) throw invalidToolResultError();
  return best;
}

export function materializeNormalizedToolResult(
  normalized: NormalizedToolResult,
  references: Readonly<{
    contentRef?: string;
    evidenceRef?: string;
    retainedContent?: RetainedToolResultContent;
  }> = {},
): MaterializedToolResult {
  if (normalized.artifactBytes !== undefined && references.contentRef === undefined) {
    throw invalidToolResultError();
  }
  if (references.evidenceRef !== undefined && references.contentRef === undefined) {
    throw invalidToolResultError();
  }
  if (
    references.retainedContent !== undefined && (
      references.contentRef === undefined || normalized.artifactBytes !== undefined ||
      !Number.isSafeInteger(references.retainedContent.totalBytes) ||
      references.retainedContent.totalBytes < 0 ||
      references.retainedContent.contentType.trim() === ''
    )
  ) {
    throw invalidToolResultError();
  }
  const truncated = normalized.artifactBytes !== undefined || references.retainedContent !== undefined;
  const contentType = references.retainedContent?.contentType ?? normalized.contentType;
  const totalBytes = references.retainedContent?.totalBytes ?? normalized.totalBytes;
  const observation: ToolObservation = Object.freeze({
    status: truncated && normalized.status === 'ok' ? 'partial' : normalized.status,
    summary: normalized.summary,
    preview: normalized.preview,
    ...(references.contentRef === undefined ? {} : { contentRef: references.contentRef }),
    contentType,
    totalBytes,
    truncated,
    // The first page uses contentRef with the default offset zero. Only the
    // Store, after validating a page, issues authenticated continuation cursors.
    provenance: normalized.provenance,
  });
  return Object.freeze({
    observation,
    modelProjection: structuredClone(observation),
    userProjection: structuredClone(observation),
    durableSummary: {
      status: observation.status,
      summary: observation.summary,
      ...(observation.contentRef === undefined ? {} : { contentRef: observation.contentRef }),
      ...(observation.contentType === undefined ? {} : { contentType: observation.contentType }),
      ...(observation.totalBytes === undefined ? {} : { totalBytes: observation.totalBytes }),
      truncated: observation.truncated,
      provenance: structuredClone(observation.provenance),
    },
    evidenceRefs: references.evidenceRef === undefined ? [] : [references.evidenceRef],
  });
}

function outputValidator(schema: Readonly<Record<string, unknown>>) {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw invalidToolResultError();
  }
  const digest = createHash('sha256').update(serialized).digest('hex');
  const cached = schemaValidators.get(digest);
  if (cached !== undefined) return cached;
  try {
    const validator = ajv.compile(structuredClone(schema));
    schemaValidators.set(digest, validator);
    return validator;
  } catch {
    throw invalidToolResultError();
  }
}

/** Bounded package-internal snapshot for sealed Runtime command payloads. */
export function snapshotRuntimeCommandPayload(value: unknown): PortableValue {
  const snapshot = boundedPortableClone(value, 32, 10_000, MAX_SYNC_HANDLER_PAYLOAD_BYTES, {});
  const freeze = (item: PortableValue): void => {
    if (item === null || typeof item !== 'object') return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(snapshot);
  return snapshot;
}

function boundedPortableClone(
  root: unknown,
  maxDepth: number,
  maxRecords: number,
  maxBytes: number,
  options: Readonly<{ signal?: AbortSignal; deadline?: string; now?: () => number }>,
): PortableValue {
  let records = 0;
  let estimatedBytes = 0;
  const ancestors = new Set<object>();
  const addEstimatedBytes = (bytes: number): void => {
    estimatedBytes += bytes;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maxBytes) {
      throw invalidToolResultError();
    }
  };
  const visit = (value: unknown, depth: number): PortableValue => {
    assertResultActive(options);
    if (depth > maxDepth) throw invalidToolResultError();
    if (value === null || typeof value === 'boolean') {
      addEstimatedBytes(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalidToolResultError();
      addEstimatedBytes(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      const bytes = jsonStringByteLength(value);
      if (bytes > MAX_HANDLER_STRING_BYTES) throw invalidToolResultError();
      addEstimatedBytes(bytes);
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw invalidToolResultError();
    let prototype: unknown;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      throw invalidToolResultError();
    }
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw invalidToolResultError();
    ancestors.add(value);
    let output: PortableValue;
    if (Array.isArray(value)) {
      let lengthDescriptor: PropertyDescriptor | undefined;
      try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length'); }
      catch { throw invalidToolResultError(); }
      if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        records + lengthDescriptor.value > maxRecords) {
        throw invalidToolResultError();
      }
      const arrayLength = lengthDescriptor.value as number;
      records += arrayLength;
      addEstimatedBytes(2 + Math.max(0, arrayLength - 1));
      const array: PortableValue[] = [];
      for (let index = 0; index < arrayLength; index += 1) {
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
        catch { throw invalidToolResultError(); }
        if (descriptor === undefined || !('value' in descriptor)) throw invalidToolResultError();
        array.push(visit(descriptor.value, depth + 1));
      }
      output = array;
    } else {
      const object = Object.create(null) as Record<string, PortableValue>;
      let entryCount = 0;
      try {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) throw invalidToolResultError();
          records += 1;
          entryCount += 1;
          if (records > maxRecords) throw invalidToolResultError();
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !('value' in descriptor)) throw invalidToolResultError();
          const keyBytes = jsonStringByteLength(key);
          if (keyBytes > 4_096) throw invalidToolResultError();
          addEstimatedBytes(keyBytes + 1 + (entryCount === 1 ? 0 : 1));
          object[key] = visit(descriptor.value, depth + 1);
        }
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw invalidToolResultError();
      }
      addEstimatedBytes(2);
      output = object;
    }
    ancestors.delete(value);
    return output;
  };
  return visit(root, 0);
}

function payloadStatus(value: PortableValue): ToolObservation['status'] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const status = (value as Record<string, PortableValue>).status;
    if (status === 'partial' || status === 'unavailable') return status;
  }
  return 'ok';
}

function payloadSummary(value: PortableValue): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, PortableValue>;
    for (const key of ['summary', 'message'] as const) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return truncateText(candidate.trim(), MAX_OBSERVATION_SUMMARY_CHARS);
      }
    }
  }
  return 'The tool completed.';
}

function payloadPreview(
  bytes: Uint8Array,
  budget: ToolResultProjectionBudget,
  observation: Omit<ToolObservation, 'preview'>,
): string {
  const full = new TextDecoder().decode(bytes);
  const maxTokens = projectionTokenLimit(budget);
  if (observationTokens(budget, observation, full) <= maxTokens) return full;
  const marker = '\n… [preview truncated] …\n';
  let low = 0;
  let high = full.length;
  let best = '';
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const headLength = Math.floor(length * 0.75);
    const candidate = `${full.slice(0, headLength)}${marker}${full.slice(-(length - headLength))}`;
    if (observationTokens(budget, observation, candidate) <= maxTokens) {
      best = candidate;
      low = length + 1;
    }
    else high = length - 1;
  }
  return best;
}

function observationTokens(
  budget: ToolResultProjectionBudget,
  observation: Omit<ToolObservation, 'preview'>,
  preview: string,
): number {
  return estimatedProjectionTokens(budget, JSON.stringify({ ...observation, preview }));
}

function projectionTokenLimit(budget: ToolResultProjectionBudget): number {
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1) throw invalidToolResultError();
  return budget.maxTokens;
}

function estimatedProjectionTokens(budget: ToolResultProjectionBudget, value: string): number {
  let tokens: number;
  try { tokens = budget.estimateTokens(value); }
  catch { throw invalidToolResultError(); }
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw invalidToolResultError();
  return tokens;
}

function jsonStringByteLength(value: string): number {
  // Reject before walking an arbitrarily large already-allocated string.
  if (value.length > MAX_HANDLER_STRING_BYTES) throw invalidToolResultError();
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
      code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (
      code < 0x20 ||
      (code >= 0xd800 && code <= 0xdfff &&
        !(code <= 0xdbff && index + 1 < value.length &&
          value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff))
    ) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_HANDLER_STRING_BYTES) throw invalidToolResultError();
  }
  return bytes;
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = '… [truncated]';
  return `${value.slice(0, maximum - suffix.length).trimEnd()}${suffix}`;
}

function conservativeProjectionBudget(): ToolResultProjectionBudget {
  return Object.freeze({
    maxTokens: 1_024,
    estimateTokens: (text: string) => Buffer.byteLength(text, 'utf8'),
  });
}

function assertResultActive(options: Readonly<{
  signal?: AbortSignal;
  deadline?: string;
  now?: () => number;
}>): void {
  if (options.signal?.aborted) {
    throw new ToolExecutionError(
      { code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' },
      'Tool result processing was cancelled.',
    );
  }
  if (options.deadline !== undefined && (options.now ?? Date.now)() >= Date.parse(options.deadline)) {
    throw new ToolExecutionError(
      { code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' },
      'Tool result processing timed out.',
    );
  }
}
