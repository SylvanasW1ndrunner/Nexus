import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentEventPayloadMap, AgentEventType } from './agent-event.js';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  validateAndRedactEventPayload,
} from './event-schema-registry.js';

export type StoredAgentEvent<T extends AgentEventType = AgentEventType> = Omit<
  AgentEvent<T>,
  'payload' | 'schemaVersion'
> & { schemaVersion: number; payload: PortableValue };

export type AgentEventUpcaster<T extends AgentEventType> = (
  schemaVersion: number,
  payload: PortableValue,
) => AgentEventPayloadMap[T];

export type AgentEventUpcasterRegistry = {
  readonly [T in AgentEventType]: AgentEventUpcaster<T>;
};

function currentVersionUpcaster<T extends AgentEventType>(type: T): AgentEventUpcaster<T> {
  return (schemaVersion, payload) => {
    const current = AGENT_EVENT_SCHEMA_REGISTRY[type].schemaVersion;
    if (type === 'artifact.created' && schemaVersion === 1) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('CORRUPT_EVENT:artifact.created legacy payload is invalid.');
      }
      const legacy = payload as Record<string, unknown>;
      if (
        typeof legacy.artifactId !== 'string' ||
        typeof legacy.mediaType !== 'string' ||
        typeof legacy.summary !== 'string'
      ) {
        throw new Error('CORRUPT_EVENT:artifact.created legacy payload is incomplete.');
      }
      const legacyDigest = createHash('sha256')
        .update(`legacy-artifact\0${legacy.artifactId}`)
        .digest('hex');
      return validateAndRedactEventPayload(type, {
        artifactId: `artifact_${legacyDigest}`,
        handle: `legacy-agent-artifact:${legacyDigest}`,
        checksum: null,
        byteSize: null,
        mediaType: legacy.mediaType,
        availability: 'legacy-unavailable',
        summary: legacy.summary,
      });
    }
    if (type === 'artifact.created' && schemaVersion === 2) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('CORRUPT_EVENT:artifact.created v2 payload is invalid.');
      }
      const prior = payload as Record<string, PortableValue>;
      if (prior.availability === 'legacy-unavailable' && typeof prior.artifactId === 'string') {
        const digest = prior.artifactId.startsWith('artifact_')
          ? prior.artifactId.slice('artifact_'.length)
          : createHash('sha256').update(`legacy-artifact\0${prior.artifactId}`).digest('hex');
        return validateAndRedactEventPayload(type, {
          ...prior,
          artifactId: `artifact_${digest}`,
          handle: `legacy-agent-artifact:${digest}`,
        });
      }
      return validateAndRedactEventPayload(type, prior);
    }
    if (schemaVersion !== current) {
      throw new Error(`UNSUPPORTED_EVENT_SCHEMA:${type}:${schemaVersion}`);
    }
    return validateAndRedactEventPayload(type, payload);
  };
}

export const AGENT_EVENT_UPCASTERS = Object.freeze(
  Object.fromEntries(
    Object.keys(AGENT_EVENT_SCHEMA_REGISTRY).map((type) => [
      type,
      currentVersionUpcaster(type as AgentEventType),
    ]),
  ),
) as AgentEventUpcasterRegistry;

export function upcastAgentEvent<T extends AgentEventType>(event: StoredAgentEvent<T>): AgentEvent<T> {
  const payload = AGENT_EVENT_UPCASTERS[event.type](event.schemaVersion, event.payload);
  return {
    ...structuredClone(event),
    schemaVersion: AGENT_EVENT_SCHEMA_REGISTRY[event.type].schemaVersion,
    payload,
  } as AgentEvent<T>;
}
