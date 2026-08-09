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
  return { ...structuredClone(event), payload } as AgentEvent<T>;
}
