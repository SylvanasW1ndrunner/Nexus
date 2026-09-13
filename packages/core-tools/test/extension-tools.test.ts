import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '@dbagent/core-skills';
import { createSkillToolContribution } from '../src/index.js';

describe('Skill prepared contribution', () => {
  it('is a direct search/load baseline contribution with Runtime-owned content', () => {
    const contribution = createSkillToolContribution(new SkillRegistry({ sessionOverlay: [{ content: '---\nname: inspect-kafka\ndescription: Inspect Kafka events.\n---\n\nRead the event schema.' }] }));
    expect(contribution.definition).toMatchObject({ name: 'skill', exposure: 'direct', access: 'write', recoveryClass: 'idempotent' });
    expect(JSON.stringify(contribution.definition.inputSchema)).not.toContain('read_resource');
  });
});
