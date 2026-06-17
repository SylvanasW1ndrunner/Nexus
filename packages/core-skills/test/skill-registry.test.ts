import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSkillsFromDirectories, parseSkillDefinition, SkillRegistry } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SkillRegistry', () => {
  it('filters allowed tools to the currently available tool set', () => {
    const registry = new SkillRegistry();
    registry.register(
      parseSkillDefinition(
        [
          'name: data_analysis',
          'description: Python 数据分析',
          'allowed_tools:',
          '  - search_schema',
          '  - query_database',
          '  - run_python_script',
          'steps:',
          '  - 查询数据',
          '  - 写 Python 脚本',
        ].join('\n'),
        'builtin',
      ),
    );

    expect(registry.filterToolsForSkill('data_analysis', ['query_database', 'search_schema'])).toEqual([
      'search_schema',
      'query_database',
    ]);
  });

  it('creates execution plans with defaults rendered into user input', () => {
    const registry = new SkillRegistry();
    registry.register(
      parseSkillDefinition(
        JSON.stringify({
          name: 'daily_gmv',
          description: '生成每日 GMV',
          system_addition: '按中文输出。',
          allowed_tools: ['query_database', 'write_workspace_file'],
          defaults: { date: 'yesterday' },
          steps: ['查询 {date}', '写入报告'],
          output_format: 'markdown',
        }),
        'workspace',
      ),
    );

    expect(
      registry.createExecutionPlan('daily_gmv', '生成 {date} 的 GMV 报告', ['query_database']),
    ).toMatchObject({
      userInput: '生成 yesterday 的 GMV 报告',
      systemAddition: '按中文输出。',
      allowedTools: ['query_database'],
      steps: ['查询 {date}', '写入报告'],
      outputFormat: 'markdown',
    });
  });
});

describe('loadSkillsFromDirectories', () => {
  it('loads builtin, user, and workspace skills with later sources overriding earlier ones', async () => {
    const root = await tempDir();
    const builtin = join(root, 'builtin');
    const user = join(root, 'user');
    const workspace = join(root, 'workspace');
    await mkdir(builtin);
    await mkdir(user);
    await mkdir(workspace);
    await writeSkill(builtin, 'daily.yaml', 'daily_report', '内置日报', ['query_database']);
    await writeSkill(user, 'daily.yaml', 'daily_report', '用户日报', ['query_database', 'write_workspace_file']);
    await writeSkill(workspace, 'schema.yaml', 'schema_doc', '工作区 Schema 文档', ['list_tables']);

    const result = await loadSkillsFromDirectories([
      { path: builtin, source: 'builtin' },
      { path: user, source: 'user' },
      { path: workspace, source: 'workspace' },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.skills.map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ['daily_report', '用户日报', 'user'],
      ['schema_doc', '工作区 Schema 文档', 'workspace'],
    ]);
  });

  it('reports invalid skills without preventing valid skills from loading', async () => {
    const root = await tempDir();
    await writeSkill(root, 'ok.yaml', 'ok_skill', '可用 Skill', ['query_database']);
    await writeFile(join(root, 'bad.yaml'), 'name: bad_skill\nallowed_tools:\n  - query_database\n', 'utf8');

    const result = await loadSkillsFromDirectories([{ path: root, source: 'workspace' }]);

    expect(result.skills.map((skill) => skill.name)).toEqual(['ok_skill']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('description');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-skills-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  directory: string,
  file: string,
  name: string,
  description: string,
  allowedTools: string[],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, file),
    [
      `name: ${name}`,
      `description: ${description}`,
      'allowed_tools:',
      ...allowedTools.map((tool) => `  - ${tool}`),
      'steps:',
      '  - 执行任务',
    ].join('\n'),
    'utf8',
  );
}
