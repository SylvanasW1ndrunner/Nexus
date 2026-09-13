#!/usr/bin/env node
import {
  initializeCliProject,
  listCliSessions,
  listCliSkills,
  startInteractiveCli,
} from './interactive-cli.js';

await runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误：${message}\n`);
  process.stderr.write('使用 schemanaut --help 查看可用命令。\n');
  process.exitCode = 1;
});

async function runCli(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.command === 'init') {
    const root = await initializeCliProject(parsed.projectDirectory);
    process.stdout.write(`SchemaNaut 项目已初始化：${root}\n`);
    process.stdout.write(
      '项目 settings.json 仅用于 MCP；模型与企业权限请在全局 ~/.schemanaut/config.toml 中配置。\n',
    );
    return;
  }
  if (parsed.command === 'skills') {
    const skills = await listCliSkills({
      projectDirectory: parsed.projectDirectory,
    });
    process.stdout.write(
      skills.length === 0
        ? '没有发现 Skills。\n'
        : `${skills
            .map(
              (skill) => `${skill.scope.padEnd(7)} ${skill.name.padEnd(28)} ${skill.description}`,
            )
            .join('\n')}\n`,
    );
    return;
  }
  if (parsed.command === 'sessions') {
    const sessions = await listCliSessions({
      projectDirectory: parsed.projectDirectory,
    });
    process.stdout.write(
      sessions.length === 0
        ? '暂无会话。\n'
        : `${sessions
            .map(
              (session) =>
                `${session.id}  ${(session.archived ? 'archived' : 'active').padEnd(8)}  ${session.title}`,
            )
            .join('\n')}\n`,
    );
    return;
  }
  await startInteractiveCli({
    projectDirectory: parsed.projectDirectory,
  });
}

type CliCommand = 'chat' | 'init' | 'skills' | 'sessions';

type CliOptions = {
  command: CliCommand;
  projectDirectory: string;
  help: boolean;
};

function parseArguments(args: string[]): CliOptions {
  let command: CliCommand = 'chat';
  let projectDirectory = process.cwd();
  let help = false;
  let index = 0;
  const first = args[0];
  if (first && ['chat', 'init', 'skills', 'sessions'].includes(first)) {
    command = first as CliCommand;
    index = 1;
  } else if (first && !first.startsWith('-')) {
    throw new Error(`未知命令：${first}`);
  }
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--project' || argument === '-C') {
      projectDirectory = requireValue(args, ++index, argument);
      continue;
    }
    if (command === 'init' && argument && !argument.startsWith('-')) {
      projectDirectory = argument;
      continue;
    }
    throw new Error(`未知参数：${argument ?? ''}`);
  }
  return { command, projectDirectory, help };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} 缺少参数。`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`SchemaNaut

Usage:
  schemanaut [chat] [-C project]
  schemanaut init [project]
  schemanaut skills [-C project]
  schemanaut sessions [-C project]

项目配置:
  模型与企业权限只从全局 ~/.schemanaut/config.toml 读取；项目 settings.json 仅保存 MCP 声明。
  协议、模型目录和上下文容量由运行时发现；CLI 不修改配置，使用 /model 选择 Session 模型。
  MCP Server 写在同一文件的 mcp.servers；Skills 使用 .schemanaut/skills/<name>/SKILL.md。

权限模式、Session、Skills、手动压缩和任务中追加要求可在 chat 内使用。
`);
}
