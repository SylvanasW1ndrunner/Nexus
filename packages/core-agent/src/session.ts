import type { LlmMessage, LlmUsage } from '@dbagent/core-llm';
import type { AgentMessage, AgentMessageDraft, AgentSession } from './types.js';
import {
  projectSession,
  type ProjectionOptions,
  type SessionProjection,
} from './session/session-projection.js';
import type { AgentEvent } from './events/agent-event.js';

export class LegacySessionAuthorityDisabledError extends Error {
  readonly code = 'SESSION_JOURNAL_REQUIRED';

  constructor(operation: string) {
    super(`${operation} is disabled: Agent Session state is projected from the Journal.`);
    this.name = 'LegacySessionAuthorityDisabledError';
  }
}

/** Builds the only normal Session view from committed Journal facts. */
export function buildSessionProjection(
  events: readonly AgentEvent[],
  options: ProjectionOptions,
): SessionProjection {
  return projectSession(events, options);
}

/**
 * Legacy constructor retained only so pre-cutover callers fail with a typed
 * diagnostic instead of silently creating a second mutable Session authority.
 */
export function createAgentSession(_input: {
  id: string;
  title: string;
  mode: AgentSession['mode'];
  userId?: string;
  modelBinding?: AgentSession['modelBinding'];
  capabilityStates?: AgentSession['capabilityStates'];
  project?: AgentSession['project'];
  activeSkills?: AgentSession['activeSkills'];
  sessionSkills?: AgentSession['sessionSkills'];
  subagentDepth?: number;
  now: () => string;
}): AgentSession {
  void _input;
  throw new LegacySessionAuthorityDisabledError('createAgentSession');
}

export function appendMessage(_session: AgentSession, _message: AgentMessage): void {
  void _session;
  void _message;
  throw new LegacySessionAuthorityDisabledError('appendMessage');
}

export function createMessage(message: AgentMessageDraft, now: () => string): AgentMessage {
  return { ...message, createdAt: now() };
}

export function toLlmMessages(_session: AgentSession): LlmMessage[] {
  void _session;
  throw new LegacySessionAuthorityDisabledError('toLlmMessages');
}

export function addUsage(_session: AgentSession, _usage?: LlmUsage): void {
  void _session;
  void _usage;
  throw new LegacySessionAuthorityDisabledError('addUsage');
}

export function forkAgentSessionForSubagent(_input: {
  parent: AgentSession;
  id: string;
  title: string;
  depth: number;
  now: () => string;
}): AgentSession {
  void _input;
  throw new LegacySessionAuthorityDisabledError('forkAgentSessionForSubagent');
}
