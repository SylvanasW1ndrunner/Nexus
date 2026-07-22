import { describe, expect, it } from 'vitest';
import { parseSkillDefinition, parseSkillDocument } from '../src/index.js';

describe('Skill parsing', () => {
  it('parses YAML and normalizes extension metadata', () => {
    const skill = parseSkillDefinition(
      [
        'name: lock_diagnosis',
        'title: 锁等待诊断',
        'description: 分析数据库阻塞链',
        'tags: [postgres, operations]',
        'allowed_tools: [diagnose_locks]',
        'steps:',
        '  - 采集锁信息',
        '  - 解释阻塞关系',
        'output_format: markdown',
      ].join('\n'),
      'organization',
      'lock.yaml',
    );

    expect(skill).toMatchObject({
      name: 'lock_diagnosis',
      title: '锁等待诊断',
      tags: ['postgres', 'operations'],
      allowedTools: ['diagnose_locks'],
      source: 'organization',
      sourcePath: 'lock.yaml',
    });
  });

  it('parses an importable SKILL.md bundle and uses its body as instructions', () => {
    const skill = parseSkillDocument(
      [
        '---',
        'name: health_check',
        'description: 检查数据库健康状态',
        'allowed_tools: [database_health_snapshot]',
        'natural_language_keywords: [健康检查]',
        '---',
        '# 工作流',
        '',
        '先读取健康快照，再解释异常，不执行写操作。',
      ].join('\n'),
      'imported',
      'health/SKILL.md',
      'health',
    );

    expect(skill.systemAddition).toContain('先读取健康快照');
    expect(skill.bundleRoot).toBe('health');
    expect(skill.source).toBe('imported');
  });

  it('rejects missing descriptions and unsupported output formats', () => {
    expect(() => parseSkillDefinition('name: invalid', 'imported')).toThrow('description');
    expect(() =>
      parseSkillDefinition('name: invalid\ndescription: demo\noutput_format: html', 'imported'),
    ).toThrow('output_format');
  });
});
