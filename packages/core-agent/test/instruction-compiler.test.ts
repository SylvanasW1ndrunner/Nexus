import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_PROTOCOL_INSTRUCTIONS,
  DEFAULT_AGENT_ROLE_INSTRUCTIONS,
  compileAgentInstructions,
  createAgentSession,
} from '../src/index.js';

const now = () => '2026-08-01T00:00:00.000Z';

describe('Agent instruction compiler', () => {
  it('keeps the kernel role generic and injects database behavior as a capability layer', () => {
    const session = createAgentSession({ id: 'generic', title: 'Generic', mode: 'read', now });
    const messages = compileAgentInstructions({
      session,
      capabilityInstructions: [
        'Database capability: use Schema RAG for metadata and push large aggregations to the database engine.',
      ],
    });
    const text = messages.map((message) => message.content).join('\n');

    expect(DEFAULT_AGENT_ROLE_INSTRUCTIONS).toContain('general-purpose agent');
    expect(DEFAULT_AGENT_ROLE_INSTRUCTIONS).not.toMatch(/SQL agent|database agent/i);
    expect(text).toContain('general-purpose agent');
    expect(text).toContain('Database capability: use Schema RAG');
  });

  it('lets a user replace the default role without removing the runtime protocol', () => {
    const session = createAgentSession({ id: 'replace', title: 'Replace', mode: 'read', now });
    const messages = compileAgentInstructions({
      session,
      systemPrompt: {
        mode: 'replace',
        content: 'You are the project data platform operator.',
      },
      managedInstructions: ['All external actions must pass host permission checks.'],
    });
    const text = messages.map((message) => message.content).join('\n');

    expect(text).toContain('You are the project data platform operator.');
    expect(text).not.toContain(DEFAULT_AGENT_ROLE_INSTRUCTIONS);
    expect(text).toContain(AGENT_RUNTIME_PROTOCOL_INSTRUCTIONS);
    expect(text).toContain('All external actions must pass host permission checks.');
  });

  it('preserves project, Skill metadata, activated Skill and task plan as distinct layers', () => {
    const session = createAgentSession({
      id: 'layers',
      title: 'Layers',
      mode: 'edit',
      activeSkills: [
        {
          name: 'clean-events',
          description: 'Clean events',
          scope: 'project',
          instructions: 'Inspect a bounded sample before choosing JSON casts.',
        },
      ],
      now,
    });
    session.taskPlan = {
      version: 1,
      goal: 'Create an event pipeline',
      tasks: [],
      createdAt: now(),
      updatedAt: now(),
    };

    const messages = compileAgentInstructions({
      session,
      projectInstructions: 'Project uses TypeScript and PostgreSQL.',
      skillCatalog: [
        { name: 'clean-events', description: 'Clean JSON events', scope: 'project' },
      ],
    });
    const text = messages.map((message) => message.content).join('\n');

    expect(text).toContain('<project_instructions>');
    expect(text).toContain('<available_skills>');
    expect(text).toContain('<activated_skill name="clean-events" scope="project">');
    expect(text).toContain('Create an event pipeline');
  });
});
