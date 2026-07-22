import { describe, expect, it } from 'vitest';
import { resolveRuntimeToolPolicy } from '../src/index.js';

describe('runtime tool policy', () => {
  it('intersects runtime policy and Skill declarations', () => {
    const policy = resolveRuntimeToolPolicy({
      runtimeTools: [
        { name: 'search_schema', dangerLevel: 'safe', readonly: true, source: 'schema-rag' },
        { name: 'query_database', dangerLevel: 'medium', readonly: true, source: 'database' },
        { name: 'execute_sql', dangerLevel: 'high', readonly: false, source: 'database' },
      ],
      skillAllowedTools: ['search_schema', 'query_database'],
      maximumDangerLevel: 'medium',
    });

    expect(policy.agentAllowedToolNames).toEqual(['search_schema', 'query_database']);
    expect(policy.blockedByPolicyToolNames).toEqual(['execute_sql']);
    expect(policy.toolPermissions.find((tool) => tool.name === 'query_database')?.approvalRequired).toBe(true);
  });

  it('reports missing tools declared by an imported Skill', () => {
    const policy = resolveRuntimeToolPolicy({
      runtimeTools: [{ name: 'search_schema', dangerLevel: 'safe', readonly: true }],
      skillAllowedTools: ['search_schema', 'diagnose_locks'],
    });

    expect(policy.blockedBySkillToolDetails).toContainEqual(
      expect.objectContaining({ toolName: 'diagnose_locks', reason: 'runtime-tool-missing' }),
    );
  });
});
