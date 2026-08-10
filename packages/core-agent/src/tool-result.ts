import type {
  AgentToolAuditEvidence,
  AgentToolCompletionEvidence,
  AgentToolResultEnvelope,
} from './types.js';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import { redactPersistedAgentValue } from './redaction.js';
import { invalidToolResultError } from './tools/tool-errors.js';

const AGENT_TOOL_RESULT_ENVELOPE = 'schemanaut.agent-tool-result.v1';
const TOOL_RESULT_SENSITIVE_KEY =
  /^(?:access[_-]?token|api[_-]?key|authorization|bearer|connection[_-]?string|credential|credentials|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|refresh[_-]?token|secret|session[_-]?token|token)$/iu;

export function createAgentToolResultEnvelope(input: {
  modelProjection: unknown;
  userProjection?: unknown;
  durableSummary: unknown;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
}): AgentToolResultEnvelope {
  return {
    type: AGENT_TOOL_RESULT_ENVELOPE,
    modelProjection: input.modelProjection,
    ...(input.userProjection === undefined ? {} : { userProjection: input.userProjection }),
    durableSummary: input.durableSummary,
    ...(input.auditEvidence === undefined ? {} : { auditEvidence: input.auditEvidence }),
    ...(input.completionEvidence === undefined
      ? {}
      : { completionEvidence: input.completionEvidence }),
  };
}

export function readAgentToolResultEnvelope(
  value: AgentToolResultEnvelope,
): AgentToolResultEnvelope {
  if (!isAgentToolResultEnvelope(value)) {
    throw new Error('Invalid Agent tool result envelope.');
  }
  return value;
}

export function isAgentToolResultEnvelope(value: unknown): value is AgentToolResultEnvelope {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === AGENT_TOOL_RESULT_ENVELOPE &&
    Object.hasOwn(value, 'modelProjection') &&
    Object.hasOwn(value, 'durableSummary')
  );
}

export type NormalizedToolResult = {
  envelope: AgentToolResultEnvelope;
  modelProjection: PortableValue;
  userProjection?: PortableValue;
  durableSummary: PortableValue;
  artifactBytes?: Uint8Array;
  artifactByteSize: number;
  modelProjectionByteSize: number;
  userProjectionByteSize?: number;
  durableSummaryByteSize: number;
  maxModelProjectionBytes: number;
  maxUserProjectionBytes: number;
  maxDurableSummaryBytes: number;
};

export type MaterializedToolResult = Pick<
  NormalizedToolResult,
  'modelProjection' | 'userProjection' | 'durableSummary'
>;

export function normalizeAgentToolResult(
  value: unknown,
  options: {
    maxModelProjectionBytes?: number;
    maxUserProjectionBytes?: number;
    maxDurableSummaryBytes?: number;
    artifactThresholdBytes?: number;
  } = {},
): NormalizedToolResult {
  if (!isAgentToolResultEnvelope(value)) throw invalidToolResultError();
  try {
    assertPortableValue(value);
  } catch {
    throw invalidToolResultError();
  }
  const envelope = sanitizeToolResultEnvelope(value);
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  const maxModel = options.maxModelProjectionBytes ?? 16 * 1024;
  const maxUser = options.maxUserProjectionBytes ?? 16 * 1024;
  const maxDurable = options.maxDurableSummaryBytes ?? 4 * 1024;
  const artifactThreshold = options.artifactThresholdBytes ?? 32 * 1024;
  const modelProjection = envelope.modelProjection as PortableValue;
  const userProjection = envelope.userProjection as PortableValue | undefined;
  const durableSummary = envelope.durableSummary as PortableValue;
  const modelProjectionByteSize = portableByteSize(modelProjection);
  const userProjectionByteSize = userProjection === undefined
    ? undefined
    : portableByteSize(userProjection);
  const durableSummaryByteSize = portableByteSize(durableSummary);
  const projectionReplacementRequired =
    modelProjectionByteSize > maxModel ||
    (userProjectionByteSize !== undefined && userProjectionByteSize > maxUser) ||
    durableSummaryByteSize > maxDurable;
  return {
    envelope,
    modelProjection: structuredClone(modelProjection),
    ...(userProjection === undefined ? {} : { userProjection: structuredClone(userProjection) }),
    durableSummary: structuredClone(durableSummary),
    ...(encoded.byteLength <= artifactThreshold && !projectionReplacementRequired
      ? {}
      : { artifactBytes: encoded }),
    artifactByteSize: encoded.byteLength,
    modelProjectionByteSize,
    ...(userProjectionByteSize === undefined ? {} : { userProjectionByteSize }),
    durableSummaryByteSize,
    maxModelProjectionBytes: maxModel,
    maxUserProjectionBytes: maxUser,
    maxDurableSummaryBytes: maxDurable,
  };
}

/**
 * Produces the bounded values that may be journaled only after the Artifact
 * handle is durable. Until this function succeeds, normalizeAgentToolResult()
 * contains the complete sanitized values and no synthetic reference.
 */
export function materializeNormalizedToolResult(
  normalized: NormalizedToolResult,
  artifactRef?: string,
): MaterializedToolResult {
  return {
    modelProjection: boundedPortableProjection(
      normalized.modelProjection,
      normalized.modelProjectionByteSize,
      normalized.maxModelProjectionBytes,
      'model projection',
      artifactRef,
    ),
    ...(normalized.userProjection === undefined || normalized.userProjectionByteSize === undefined
      ? {}
      : {
          userProjection: boundedPortableProjection(
            normalized.userProjection,
            normalized.userProjectionByteSize,
            normalized.maxUserProjectionBytes,
            'user projection',
            artifactRef,
          ),
        }),
    durableSummary: boundedPortableProjection(
      normalized.durableSummary,
      normalized.durableSummaryByteSize,
      normalized.maxDurableSummaryBytes,
      'durable summary',
      artifactRef,
    ),
  };
}

function sanitizeToolResultEnvelope(value: AgentToolResultEnvelope): AgentToolResultEnvelope {
  const redacted = redactPersistedAgentValue(value);
  const sanitized = redactLocalDiagnostics(redacted) as AgentToolResultEnvelope;
  try {
    assertPortableValue(sanitized);
  } catch {
    throw invalidToolResultError();
  }
  return structuredClone(sanitized);
}

function redactLocalDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLocalDiagnostics);
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
    if (TOOL_RESULT_SENSITIVE_KEY.test(key)) {
      output[`${key}Redacted`] = true;
    } else if (normalized === 'stack' || normalized === 'stacktrace' || normalized === 'localpath') {
      output[key] = '[REDACTED]';
    } else if (normalized === 'path' && typeof child === 'string' && isLocalAbsolutePath(child)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactLocalDiagnostics(child);
    }
  }
  return output;
}

function isLocalAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|file:\/\/|\/(?:Users|home|root|var|tmp|etc)\/)/u.test(value);
}

function boundedPortableProjection(
  value: PortableValue,
  byteSize: number,
  maximumBytes: number,
  label: string,
  artifactRef: string | undefined,
): PortableValue {
  if (byteSize <= maximumBytes) return structuredClone(value);
  if (artifactRef === undefined || artifactRef.length === 0) throw invalidToolResultError();
  return {
    type: 'schemanaut.bounded-projection.v1',
    summary: `${label} is available in the referenced artifact.`,
    byteSize,
    artifactRef,
  };
}

function portableByteSize(value: PortableValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
