import { describe, expect, it } from 'vitest';
import { parseSkillInvocation, searchSkillCatalog, SkillRegistry } from '../src/index.js';

const catalog = [
  {
    name: 'query-and-answer',
    description: '生成统计、趋势和聚合 SQL，并由数据库执行。',
    scope: 'system' as const,
  },
  {
    name: 'recover-from-sql-error',
    description: '根据数据库错误和最新 Schema 修正 SQL。',
    scope: 'system' as const,
  },
  {
    name: 'cleanup-traffic-events',
    description: '清洗流量事件并发现异常字段。',
    scope: 'project' as const,
  },
];

describe('Skill catalog search and explicit invocation', () => {
  it('searches only standard name and description fields', () => {
    expect(searchSkillCatalog(catalog, 'SQL 错误')[0]?.skill.name).toBe('recover-from-sql-error');
    expect(searchSkillCatalog(catalog, '流量清洗')[0]?.skill.name).toBe('cleanup-traffic-events');
    expect(searchSkillCatalog(catalog, 'query-and-answer')[0]?.score).toBeGreaterThan(
      searchSkillCatalog(catalog, '统计')[0]?.score ?? 0,
    );
  });

  it('parses slash invocation, qualified scope and arguments', () => {
    expect(parseSkillInvocation('/query-and-answer 统计最近七天订单')).toEqual({
      name: 'query-and-answer',
      arguments: '统计最近七天订单',
      raw: '/query-and-answer 统计最近七天订单',
    });
    expect(parseSkillInvocation('/project:cleanup-traffic-events file.json')).toEqual({
      name: 'cleanup-traffic-events',
      scope: 'project',
      arguments: 'file.json',
      raw: '/project:cleanup-traffic-events file.json',
    });
  });

  it('does not steal reserved CLI commands or accept malformed commands', () => {
    expect(parseSkillInvocation('/skills')).toBeUndefined();
    expect(parseSkillInvocation('/compact now')).toBeUndefined();
    expect(parseSkillInvocation('/unknown-scope:skill')).toBeUndefined();
    expect(parseSkillInvocation('/Invalid_Name')).toBeUndefined();
    expect(parseSkillInvocation('normal message')).toBeUndefined();
  });

  it('activates an explicitly invoked Session overlay', async () => {
    const registry = new SkillRegistry({
      sessionOverlay: [
        {
          content: [
            '---',
            'name: inspect-events',
            'description: 检查事件数据。',
            '---',
            '只读取完成任务所需的少量样例。',
          ].join('\n'),
        },
      ],
    });
    const activated = await registry.invoke('/inspect-events kafka_events');

    expect(activated).toMatchObject({
      name: 'inspect-events',
      arguments: 'kafka_events',
      skill: {
        scope: 'session',
        instructions: '只读取完成任务所需的少量样例。',
      },
    });
  });
});
