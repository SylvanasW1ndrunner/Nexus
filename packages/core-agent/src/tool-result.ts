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
};

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
  const modelProjection = boundedPortableProjection(
    envelope.modelProjection as PortableValue, maxModel, 'model projection',
  );
  const durableSummary = boundedPortableProjection(
    envelope.durableSummary as PortableValue, maxDurable, 'durable summary',
  );
  return {
    envelope,
    modelProjection,
    ...(envelope.userProjection === undefined
      ? {}
      : {
          userProjection: boundedPortableProjection(
            envelope.userProjection as PortableValue, maxUser, 'user projection',
          ),
        }),
    durableSummary,
    ...(encoded.byteLength <= artifactThreshold ? {} : { artifactBytes: encoded }),
    artifactByteSize: encoded.byteLength,
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
  maximumBytes: number,
  label: string,
): PortableValue {
  const byteSize = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (byteSize <= maximumBytes) return structuredClone(value);
  return {
    type: 'schemanaut.bounded-projection.v1',
    summary: `${label} is available in the referenced artifact.`,
    byteSize,
  };
}
