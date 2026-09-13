import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSkillTextResource, SkillRegistry, type SkillDirectorySource } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('SkillRegistry scopes and progressive disclosure', () => {
  it('resolves session > project > user > system and can explicitly load a lower scope', async () => {
    const root = await temporaryDirectory();
    const sources = await scopedSources(root);
    for (const source of sources) {
      await writeSkill(
        source.path,
        'query-and-answer',
        `${source.scope} description`,
        `${source.scope} instructions`,
      );
    }

    const registry = new SkillRegistry({ sources });
    const refreshed = await registry.refresh();

    expect(registry.get('query-and-answer')).toEqual({
      name: 'query-and-answer',
      description: 'session description',
      scope: 'session',
    });
    expect(await registry.load({ name: 'query-and-answer', scope: 'project' })).toMatchObject({
      scope: 'project',
      instructions: 'project instructions',
    });
    expect(refreshed.conflicts[0]).toMatchObject({
      name: 'query-and-answer',
      selected: { scope: 'session' },
      shadowed: [{ scope: 'project' }, { scope: 'user' }, { scope: 'system' }],
    });
  });

  it('keeps Session overlays isolated from Project Skills and other registries', async () => {
    const root = await temporaryDirectory();
    const project = join(root, 'project');
    await writeSkill(project, 'cleanup-events', '项目级清洗规则', '项目说明');

    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: project }],
      sessionOverlay: [
        {
          content: skillDocument('cleanup-events', '当前会话临时清洗规则', '仅当前 Session 使用'),
        },
      ],
    });
    const second = new SkillRegistry({
      sources: [{ scope: 'project', path: project }],
    });
    await Promise.all([first.refresh(), second.refresh()]);

    expect(first.get('cleanup-events')?.scope).toBe('session');
    expect((await first.load('cleanup-events')).instructions).toContain('仅当前 Session');
    expect(second.get('cleanup-events')?.scope).toBe('project');
    expect((await second.load('cleanup-events')).instructions).toBe('项目说明');

    first.replaceSessionOverlay([]);
    expect(first.get('cleanup-events')?.scope).toBe('project');
  });

  it('derives isolated Session views from one refreshable shared snapshot', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'shared-rule', '共享规则。', '共享正文');
    const shared = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await shared.refresh();

    const first = shared.createSessionView([
      {
        content: skillDocument('private-rule', 'Session A。', '只属于 Session A'),
      },
    ]);
    const second = shared.createSessionView([
      {
        content: skillDocument('private-rule', 'Session B。', '只属于 Session B'),
      },
    ]);

    expect((await first.load('private-rule')).instructions).toBe('只属于 Session A');
    expect((await second.load('private-rule')).instructions).toBe('只属于 Session B');
    expect(shared.get('private-rule')).toBeUndefined();
    expect(first.get('shared-rule')?.scope).toBe('project');
    expect(second.get('shared-rule')?.scope).toBe('project');

    await writeSkill(root, 'added-later', '动态共享规则。', '刷新后可见');
    await shared.refresh();
    const refreshedFirst = shared.createSessionView([
      {
        content: skillDocument('private-rule', 'Session A。', '只属于 Session A'),
      },
    ]);
    expect(refreshedFirst.get('added-later')?.scope).toBe('project');
    expect((await refreshedFirst.load('private-rule')).instructions).toBe('只属于 Session A');
    expect(second.get('added-later')).toBeUndefined();
  });

  it('exposes only name, description and scope in the model catalog', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'science-query', '查询大科学实验数据。', '包含内部路径不应进入目录。', {
      metadata: ['  author: SchemaNaut', '  private-note: hidden'],
    });
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();

    const serialized = JSON.stringify(registry.catalogForModel());
    expect(registry.catalogForModel()).toEqual([
      {
        name: 'science-query',
        description: '查询大科学实验数据。',
        scope: 'project',
      },
    ]);
    expect(serialized).not.toContain('SKILL.md');
    expect(serialized).not.toContain('private-note');
    expect(serialized).not.toContain('包含内部路径');
  });

  it('discovers only SKILL.md bundles and isolates malformed Skills', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'valid-skill', '有效 Skill。', '有效说明');
    await mkdir(join(root, 'broken-skill'), { recursive: true });
    await writeFile(
      join(root, 'broken-skill', 'SKILL.md'),
      ['---', 'name: broken-skill', 'description: [invalid', '---'].join('\n'),
      'utf8',
    );
    await writeFile(join(root, 'legacy.yaml'), 'name: legacy\ndescription: 不应再加载', 'utf8');
    await writeFile(
      join(root, 'legacy.json'),
      '{"name":"legacy-json","description":"不应再加载"}',
      'utf8',
    );

    const registry = new SkillRegistry({
      sources: [{ scope: 'user', path: root }],
    });
    const result = await registry.refresh();

    expect(result.skills.map(({ name }) => name)).toEqual(['valid-skill']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      scope: 'user',
      code: 'invalid-frontmatter',
    });
  });

  it('uses later sources deterministically within the same scope', async () => {
    const root = await temporaryDirectory();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writeSkill(first, 'same-name', '第一个目录。', 'first');
    await writeSkill(second, 'same-name', '第二个目录。', 'second');
    const registry = new SkillRegistry({
      sources: [
        { scope: 'project', path: first, id: 'first' },
        { scope: 'project', path: second, id: 'second' },
      ],
    });
    await registry.refresh();

    expect(registry.get('same-name')?.description).toBe('第二个目录。');
    expect(registry.inspect('same-name')?.sourceId).toBe('second');
  });

  it('never commits a stale disk snapshot when sources change during refresh', async () => {
    const root = await temporaryDirectory();
    const previous = join(root, 'previous');
    const current = join(root, 'current');
    await writeSkill(previous, 'previous-skill', '旧来源。', 'old');
    await writeSkill(current, 'current-skill', '新来源。', 'new');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: previous, id: 'previous' }],
    });

    const refresh = registry.refresh();
    registry.setSources([{ scope: 'project', path: current, id: 'current' }]);
    await refresh;

    expect(registry.inspect('previous-skill')).toBeUndefined();
    expect(registry.inspect('current-skill')).toMatchObject({ sourceId: 'current' });
  });

  it('isolates a SKILL.md that cannot be frozen within the per-file limit', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'large-body', '用于验证渐进披露。', 'x'.repeat(4 * 1_024 * 1_024 + 1));
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });

    const result = await registry.refresh();
    expect(result.skills).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('file-too-large');
    expect(result.issues[0]?.message).toContain('per-file');
  });

  it('reads Tier-3 resources on demand and rejects path escape', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'with-reference', '读取参考资料。', '按需读取 references。');
    const referenceDirectory = join(root, 'with-reference', 'references');
    await mkdir(referenceDirectory, { recursive: true });
    await writeFile(join(referenceDirectory, 'schema.md'), '字段说明', 'utf8');
    await writeFile(join(root, 'outside.md'), '不能读取', 'utf8');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();
    const descriptor = registry.inspect('with-reference')!;

    await expect(readSkillTextResource(descriptor, 'references/schema.md')).resolves.toBe(
      '字段说明',
    );
    await expect(readSkillTextResource(descriptor, '../outside.md')).rejects.toThrow('escapes');
    await expect(readSkillTextResource(descriptor, join(root, 'outside.md'))).rejects.toThrow(
      'relative path',
    );
  });

  it('refreshes changed metadata live without leaking body content', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'live-skill', '初始说明。', '初始正文');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();

    const changed = new Promise<void>((resolveChange, rejectChange) => {
      const timeout = setTimeout(
        () => rejectChange(new Error('Skill watcher did not observe the update.')),
        3_000,
      );
      registry.watch({
        debounceMs: 25,
        onChange(result) {
          if (result.skills[0]?.description === '更新说明。') {
            clearTimeout(timeout);
            registry.stopWatching();
            resolveChange();
          }
        },
        onError(error) {
          clearTimeout(timeout);
          registry.stopWatching();
          rejectChange(error instanceof Error ? error : new Error(String(error)));
        },
      });
    });

    await writeSkill(root, 'live-skill', '更新说明。', '更新后的正文');
    await changed;
    expect(registry.get('live-skill')?.description).toBe('更新说明。');
    expect((await registry.load('live-skill')).instructions).toBe('更新后的正文');
  });

  it('live-refreshes newly added and removed Skill directories', async () => {
    const root = await temporaryDirectory();
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();

    let resolveAdded: (() => void) | undefined;
    let resolveRemoved: (() => void) | undefined;
    const added = new Promise<void>((resolvePromise) => {
      resolveAdded = resolvePromise;
    });
    const removed = new Promise<void>((resolvePromise) => {
      resolveRemoved = resolvePromise;
    });
    const timeout = setTimeout(() => {
      registry.stopWatching();
      resolveAdded?.();
      resolveRemoved?.();
    }, 3_000);
    registry.watch({
      debounceMs: 25,
      pollIntervalMs: 100,
      onChange(result) {
        if (result.skills.some(({ name }) => name === 'added-live')) resolveAdded?.();
        if (resolveAdded && !result.skills.some(({ name }) => name === 'added-live')) {
          resolveRemoved?.();
        }
      },
    });

    await writeSkill(root, 'added-live', '动态添加。', '动态正文');
    await added;
    expect(registry.get('added-live')).toBeDefined();
    await rm(join(root, 'added-live'), { recursive: true, force: true });
    await removed;
    clearTimeout(timeout);
    registry.stopWatching();
    expect(registry.get('added-live')).toBeUndefined();
  });

  it('loads a source that directly points at one Skill directory', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'direct-skill', '直接目录。', '直接加载');
    const registry = new SkillRegistry({
      sources: [{ scope: 'user', path: join(root, 'direct-skill') }],
    });
    await registry.refresh();
    expect(registry.list()).toEqual([
      { name: 'direct-skill', description: '直接目录。', scope: 'user' },
    ]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-skills-'));
  temporaryDirectories.push(path);
  return path;
}

async function scopedSources(root: string): Promise<SkillDirectorySource[]> {
  const scopes = ['system', 'user', 'project', 'session'] as const;
  const sources = scopes.map((scope) => ({ scope, path: join(root, scope) }));
  await Promise.all(sources.map(async ({ path }) => await mkdir(path, { recursive: true })));
  return sources;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string,
  options: { metadata?: string[] } = {},
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    skillDocument(name, description, body, options),
    'utf8',
  );
}

function skillDocument(
  name: string,
  description: string,
  body: string,
  options: { metadata?: string[] } = {},
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(options.metadata ? ['metadata:', ...options.metadata] : []),
    '---',
    body,
  ].join('\n');
}
