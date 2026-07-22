import { describe, expect, it } from 'vitest';
import { createDefaultBuiltinSkills, registerDefaultBuiltinSkills, SkillRegistry } from '../src/index.js';

describe('default builtin Skills', () => {
  it('contains only NL2SQL and database operations workflows', () => {
    expect(createDefaultBuiltinSkills().map((skill) => skill.name)).toEqual([
      'nl2sql_query',
      'schema_context_enrichment',
      'explain_sql',
      'database_health_check',
      'slow_query_diagnosis',
      'lock_diagnosis',
      'long_transaction_diagnosis',
    ]);
  });

  it('registers and matches a database operations workflow', () => {
    const registry = new SkillRegistry();
    registerDefaultBuiltinSkills(registry);

    expect(
      registry.createAutoExecutionPlan({
        userInput: '检查数据库里有没有长事务',
        availableTools: ['diagnose_long_transactions'],
      })?.candidate.skill.name,
    ).toBe('long_transaction_diagnosis');
  });

  it('returns defensive copies', () => {
    const first = createDefaultBuiltinSkills();
    first[0]?.allowedTools.push('mutated');
    expect(createDefaultBuiltinSkills()[0]?.allowedTools).not.toContain('mutated');
  });
});
