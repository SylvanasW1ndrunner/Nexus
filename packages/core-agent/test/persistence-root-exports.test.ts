import { describe, expect, it } from 'vitest';
import {
  AgentSessionStore,
  JournalSessionStore,
  ProjectArtifactStore,
  StateMigrationRunner,
  createAgentSession,
  projectSession,
} from '../src/index.js';

describe('persistence root exports', () => {
  it('keeps the legacy runtime usable while exposing Journal persistence separately', () => {
    const session = createAgentSession({
      id: 'legacy-runtime-session',
      title: 'Legacy runtime',
      mode: 'read',
      now: () => '2026-08-10T00:00:00.000Z',
    });
    expect(session).toMatchObject({ id: 'legacy-runtime-session', messages: [], aborted: false });
    expect(AgentSessionStore).toBeTypeOf('function');
    expect(JournalSessionStore).toBeTypeOf('function');
    expect(ProjectArtifactStore).toBeTypeOf('function');
    expect(StateMigrationRunner).toBeTypeOf('function');
    expect(projectSession).toBeTypeOf('function');
  });
});
