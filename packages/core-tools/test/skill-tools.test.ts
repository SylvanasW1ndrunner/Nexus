import { describe, expect, it } from 'vitest';
import { ToolRegistry, createAgentSession } from '@dbagent/core-agent';
import { SkillRegistry } from '@dbagent/core-skills';
import { registerSkillTools } from '../src/index.js';

describe('unified Skill tool', () => {
  it('keeps one direct model entry and loads Markdown only after activation', async () => {
    const registry = new ToolRegistry();
    const skills = new SkillRegistry({
      sessionOverlay: [
        {
          content: [
            '---',
            'name: inspect-kafka',
            'description: 检查 Kafka JSON 数据形态并规划处理步骤。',
            '---',
            '先读取少量样例，再根据实际字段生成处理脚本。',
          ].join('\n'),
        },
      ],
    });
    registerSkillTools(registry, skills);
    const session = createAgentSession({
      id: 'skill-session',
      title: 'Skills',
      mode: 'read',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    const tool = registry.get('skill')!;

    expect(tool.descriptor).toMatchObject({ exposure: 'direct' });
    expect(registry.get('skill_search')?.descriptor.exposure).toBe('hidden');
    expect(registry.get('skill_load')?.descriptor.exposure).toBe('hidden');

    const searched = (await tool.handler(
      { action: 'search', query: 'Kafka JSON' },
      { session },
    )) as { skills: Array<{ name: string; description: string }> };
    expect(searched.skills).toEqual([
      {
        name: 'inspect-kafka',
        description: '检查 Kafka JSON 数据形态并规划处理步骤。',
        scope: 'session',
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain('先读取少量样例');

    const loaded = await tool.handler(
      { action: 'load', name: 'inspect-kafka' },
      { session },
    );
    expect(loaded).toMatchObject({
      name: 'inspect-kafka',
      instructions: '先读取少量样例，再根据实际字段生成处理脚本。',
    });
    expect(session.activeSkills).toMatchObject([
      { name: 'inspect-kafka', scope: 'session' },
    ]);
  });

  it('rejects action-specific arguments instead of silently guessing an operation', async () => {
    const registry = new ToolRegistry();
    registerSkillTools(registry, new SkillRegistry());
    const session = createAgentSession({
      id: 'skill-session',
      title: 'Skills',
      mode: 'read',
      now: () => '2026-08-01T00:00:00.000Z',
    });

    await expect(
      registry.get('skill')!.handler({ action: 'load' }, { session }),
    ).rejects.toThrow('name');
    await expect(
      registry.get('skill')!.handler({ action: 'unknown' }, { session }),
    ).rejects.toThrow('Unsupported Skill action');
  });

  it('keeps capability-bound Skills out of search and activation when their package is unavailable', async () => {
    const registry = new ToolRegistry();
    const skills = new SkillRegistry({
      sessionOverlay: [
        {
          content: [
            '---',
            'name: database-only',
            'description: Requires an active database.',
            'metadata:',
            "  capabilities: 'database'",
            '---',
            'Use database tools.',
          ].join('\n'),
        },
        {
          content: [
            '---',
            'name: general-project',
            'description: Works in every project.',
            '---',
            'Inspect project files.',
          ].join('\n'),
        },
      ],
    });
    registerSkillTools(registry, skills, {
      isAvailable: (descriptor) => descriptor.metadata.capabilities !== 'database',
    });
    const session = createAgentSession({
      id: 'capability-session',
      title: 'Capabilities',
      mode: 'read',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    const tool = registry.get('skill')!;

    await expect(
      tool.handler({ action: 'search', query: 'project database', limit: 20 }, { session }),
    ).resolves.toEqual({
      skills: [
        {
          name: 'general-project',
          description: 'Works in every project.',
          scope: 'session',
        },
      ],
    });
    await expect(
      tool.handler({ action: 'load', name: 'database-only' }, { session }),
    ).rejects.toThrow('not available');
  });
});
