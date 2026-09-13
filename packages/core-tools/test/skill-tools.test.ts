import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '@dbagent/core-skills';
import { createSkillToolContribution } from '../src/index.js';

describe('skill tool contract', () => {
  it('uses only search/load and current prepared metadata', () => {
    const contribution = createSkillToolContribution(new SkillRegistry());
    expect(contribution.definition).toMatchObject({ name: 'skill', exposure: 'direct', access: 'write', recoveryClass: 'idempotent' });
    expect(JSON.stringify(contribution.definition.inputSchema)).not.toContain('read_resource');
  });
});
