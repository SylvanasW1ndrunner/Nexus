import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProjectContext } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project context compiler', () => {
  it('deterministically compiles stable project guidance and technology metadata', async () => {
    const root = await temporaryProject();
    await mkdir(join(root, '.schemanaut'), { recursive: true });
    await mkdir(join(root, 'services', 'cleaner'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), '# 项目规则\n使用 pnpm 完成验证。\n', 'utf8');
    await writeFile(
      join(root, 'services', 'cleaner', 'AGENTS.md'),
      '# 清洗服务\n修改后运行 Python 数据质量测试。\n',
      'utf8',
    );
    await writeFile(
      join(root, '.schemanaut', 'AGENT.md'),
      '# SchemaNaut\n数据库操作优先读取实时 Schema。\n',
      'utf8',
    );
    await writeFile(join(root, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n', 'utf8');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    await writeFile(join(root, 'src.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname="cleaner"\n', 'utf8');
    await writeFile(join(root, 'clean.py'), 'print("ok")\n', 'utf8');
    await writeFile(join(root, '.env'), 'API_KEY=must-not-enter-project-context\n', 'utf8');

    const compilation = await compileProjectContext({ rootPath: root });

    expect(compilation.modelContext).toMatchObject({
      technologies: {
        languages: ['python', 'typescript'],
        packageManagers: ['pnpm', 'python'],
      },
    });
    expect(compilation.modelContext.instructions.map((item) => item.path)).toEqual([
      '.schemanaut/AGENT.md',
      'AGENTS.md',
      'services/cleaner/AGENTS.md',
    ]);
    expect(compilation.compiledInstructions).toContain('数据库操作优先读取实时 Schema');
    expect(compilation.compiledInstructions).toContain('path="services/cleaner"');
    expect(compilation.compiledInstructions).not.toContain('must-not-enter-project-context');
    expect(compilation.compiledInstructions).not.toContain(compilation.fingerprint);
    expect(compilation.compiledInstructions).not.toContain('<project_skills>');
    expect(compilation.compiledInstructions).not.toContain('<active_capabilities>');
    expect(compilation.compiledInstructions).not.toContain('<mcp_servers>');
    expect(compilation.compiledInstructions).not.toContain('database_capabilities');
  });

  it('changes the internal fingerprint when a relevant instruction changes', async () => {
    const root = await temporaryProject();
    const path = join(root, 'AGENTS.md');
    await writeFile(path, 'first rule\n', 'utf8');
    const first = await compileProjectContext({ rootPath: root });
    await writeFile(path, 'second rule\n', 'utf8');
    const second = await compileProjectContext({ rootPath: root });

    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.compiledInstructions).toContain('first rule');
    expect(second.compiledInstructions).toContain('second rule');
  });
});

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-project-compiler-'));
  temporaryDirectories.push(path);
  return path;
}
