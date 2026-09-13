import { describe, expect, it } from 'vitest';
import { parseSkillDocument, parseSkillMetadata, type SkillParseContext } from '../src/index.js';

const context: SkillParseContext = {
  scope: 'project',
  sourceId: 'project',
  sourcePath: 'C:/workspace/.schemanaut/skills/order-analysis/SKILL.md',
  bundleRoot: 'C:/workspace/.schemanaut/skills/order-analysis',
  sourceOrder: 0,
  expectedName: 'order-analysis',
};

describe('Agent Skills document parsing', () => {
  it('parses real YAML frontmatter and keeps Markdown instructions separate', () => {
    const document = parseSkillDocument(
      [
        '\uFEFF---\r',
        'name: order-analysis\r',
        'description: >\r',
        '  生成订单统计 SQL，并让数据库完成聚合。\r',
        '  用户询问订单趋势或金额时使用。\r',
        'license: Apache-2.0\r',
        'compatibility: 需要数据库查询工具\r',
        'metadata:\r',
        '  author: SchemaNaut\r',
        '  version: "1.2.0"\r',
        '  schemanaut: "auto-and-explicit"\r',
        'allowed-tools: Read Bash(git status) sql_execute\r',
        'user-invocable: true\r',
        '---\r',
        '\r',
        '# 订单分析\r',
        '\r',
        '让数据库执行统计，不要读取整张表。\r',
      ].join('\n'),
      context,
    );

    expect(document).toMatchObject({
      name: 'order-analysis',
      description: '生成订单统计 SQL，并让数据库完成聚合。 用户询问订单趋势或金额时使用。',
      scope: 'project',
      license: 'Apache-2.0',
      compatibility: '需要数据库查询工具',
      metadata: {
        author: 'SchemaNaut',
        version: '1.2.0',
        schemanaut: 'auto-and-explicit',
      },
      allowedTools: ['Read', 'Bash(git status)', 'sql_execute'],
      extensions: { 'user-invocable': true },
    });
    expect(document.instructions).toContain('让数据库执行统计');
  });

  it('returns Tier-1 metadata without carrying the Markdown body', () => {
    const descriptor = parseSkillMetadata(
      [
        '---',
        'name: order-analysis',
        'description: 生成订单统计 SQL。',
        '---',
        '# 这段正文只应在激活后读取',
      ].join('\n'),
      context,
    );

    expect('instructions' in descriptor).toBe(false);
    expect(JSON.stringify(descriptor)).not.toContain('只应在激活后读取');
  });

  it('binds parser-created single-file revisions to their complete provenance', () => {
    const content = [
      '---',
      'name: order-analysis',
      'description: Analyze orders.',
      '---',
      'Inspect orders.',
    ].join('\n');
    const first = parseSkillDocument(content, context);
    const second = parseSkillDocument(content, {
      ...context,
      sourceId: 'another-source',
      sourcePath: 'C:/another/order-analysis/SKILL.md',
      bundleRoot: 'C:/another/order-analysis',
      sourceOrder: 1,
    });

    expect(first.revisionRef.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.revisionRef.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.revisionRef.revisionId).not.toBe(first.contentDigest);
    expect(second.revisionRef.revisionId).not.toBe(first.revisionRef.revisionId);
  });

  it('rejects a caller-supplied metadata digest that does not identify the document', () => {
    const content = [
      '---',
      'name: order-analysis',
      'description: Analyze orders.',
      '---',
      'Inspect orders.',
    ].join('\n');

    expect(() =>
      parseSkillMetadata(content, {
        ...context,
        contentDigest: '0'.repeat(64),
      }),
    ).toThrow(/content digest/i);
  });

  it('rejects an injected revision reference that conflicts with parser provenance', () => {
    const content = [
      '---',
      'name: order-analysis',
      'description: Analyze orders.',
      '---',
      'Inspect orders.',
    ].join('\n');
    const parsed = parseSkillDocument(content, context);

    expect(() =>
      parseSkillDocument(content, {
        ...context,
        revisionRef: { ...parsed.revisionRef, sourceId: 'forged-source' },
      }),
    ).toThrow(/revision.*provenance/i);

    expect(() =>
      parseSkillDocument(content, {
        ...context,
        revisionRef: { ...parsed.revisionRef, revisionId: '0'.repeat(64) },
      }),
    ).toThrow(/revision.*identity/i);
  });

  it('rejects flat YAML, JSON manifests and invalid standard fields', () => {
    expect(() => parseSkillDocument('name: order-analysis\ndescription: legacy', context)).toThrow(
      'must start with YAML frontmatter',
    );
    expect(() =>
      parseSkillDocument('{"name":"order-analysis","description":"legacy"}', context),
    ).toThrow('must start with YAML frontmatter');
    expect(() =>
      parseSkillDocument(
        ['---', 'name: Order_Analysis', 'description: invalid', '---'].join('\n'),
        {
          scope: context.scope,
          sourceId: context.sourceId,
          sourcePath: context.sourcePath,
          bundleRoot: context.bundleRoot,
          sourceOrder: context.sourceOrder,
        },
      ),
    ).toThrow('lowercase letters');
    expect(() =>
      parseSkillDocument(
        [
          '---',
          'name: order-analysis',
          'description: valid',
          'metadata:',
          '  nested:',
          '    unsupported: true',
          '---',
        ].join('\n'),
        context,
      ),
    ).toThrow('metadata.nested');
    expect(() =>
      parseSkillDocument(
        [
          '---',
          'name: order-analysis',
          'description: valid',
          'allowed-tools:',
          '  - Read',
          '---',
        ].join('\n'),
        context,
      ),
    ).toThrow('space-separated string');
  });

  it('enforces the directory-name rule and rejects duplicate YAML keys', () => {
    expect(() =>
      parseSkillDocument(
        ['---', 'name: another-name', 'description: valid', '---'].join('\n'),
        context,
      ),
    ).toThrow('must match its parent directory');

    expect(() =>
      parseSkillDocument(
        ['---', 'name: order-analysis', 'description: first', 'description: second', '---'].join(
          '\n',
        ),
        context,
      ),
    ).toThrow('Map keys must be unique');
  });

  it('rejects aliases and oversized descriptions', () => {
    expect(() =>
      parseSkillDocument(
        [
          '---',
          'name: order-analysis',
          'description: valid',
          'metadata: &metadata',
          '  author: SchemaNaut',
          'copied: *metadata',
          '---',
        ].join('\n'),
        context,
      ),
    ).toThrow();

    expect(() =>
      parseSkillDocument(
        ['---', 'name: order-analysis', `description: ${'x'.repeat(1_025)}`, '---'].join('\n'),
        context,
      ),
    ).toThrow('1024');
  });
});
