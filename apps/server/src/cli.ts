#!/usr/bin/env node
import {
  initializeCliProject,
  listCliSessions,
  listCliSkills,
  startInteractiveCli,
} from './interactive-cli.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, startDatabaseAgentServer } from './server.js';

await runCli(process.argv.slice(2));

async function runCli(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.command === 'init') {
    const root = await initializeCliProject(parsed.projectDirectory);
    process.stdout.write(`SchemaNaut 项目已初始化：${root}\n`);
    process.stdout.write('已创建 .schemanaut、sql 和 artifacts 目录；未写入任何密钥。\n');
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
            .map((session) => `${session.id}  ${session.mode.padEnd(4)}  ${session.title}`)
            .join('\n')}\n`,
    );
    return;
  }
  if (parsed.command === 'chat') {
    await startInteractiveCli({
      projectDirectory: parsed.projectDirectory,
    });
    return;
  }

  const started = await startDatabaseAgentServer({
    host: parsed.host,
    port: parsed.port,
  });
  process.stdout.write(`SchemaNaut Web/API 已启动：${started.url}\n`);
  process.stdout.write('仅监听本机；模型密钥和数据库密码只保存在当前进程内存。\n');

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void started.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.stderr.write('SchemaNaut failed to shut down cleanly.\n');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

type CliCommand = 'serve' | 'chat' | 'init' | 'skills' | 'sessions';

type CliOptions = {
  command: CliCommand;
  host: string;
  port: number;
  projectDirectory: string;
  help: boolean;
};

function parseArguments(args: string[]): CliOptions {
  let command: CliCommand = 'serve';
  let host = DEFAULT_SERVER_HOST;
  let port = DEFAULT_SERVER_PORT;
  let projectDirectory = process.cwd();
  let help = false;
  let index = 0;
  const first = args[0];
  if (first && ['serve', 'chat', 'init', 'skills', 'sessions'].includes(first)) {
    command = first as CliCommand;
    index = 1;
  }
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--host') {
      host = requireValue(args, ++index, '--host');
      continue;
    }
    if (argument === '--port') {
      const value = Number(requireValue(args, ++index, '--port'));
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error('--port 必须是 0 到 65535 之间的整数。');
      }
      port = value;
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
  return { command, host, port, projectDirectory, help };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} 缺少参数。`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`SchemaNaut

Usage:
  schemanaut serve [--host 127.0.0.1] [--port 3721]
  schemanaut chat [-C project]
  schemanaut init [project]
  schemanaut skills [-C project]
  schemanaut sessions [-C project]

chat 环境变量:
  SCHEMANAUT_LLM_BASE_URL     OpenAI-compatible endpoint
  SCHEMANAUT_LLM_API_KEY      远程模型密钥；本地 Ollama 可省略
  SCHEMANAUT_LLM_MODEL        模型名
  SCHEMANAUT_DATABASE_URL     postgresql://user:password@host:5432/database

权限模式、Session、Skills、手动压缩和任务中追加要求可在 chat 内使用。
`);
}
