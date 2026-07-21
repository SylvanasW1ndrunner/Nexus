#!/usr/bin/env node
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, startDatabaseAgentServer } from './server.js';

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
} else {
  const started = await startDatabaseAgentServer({ host: options.host, port: options.port });
  process.stdout.write(`DBAgent MVP 已启动：${started.url}\n`);
  process.stdout.write('仅监听本机；模型密钥和数据库密码只保存在当前进程内存。\n');

  const shutdown = () => {
    started.server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

type CliOptions = {
  host: string;
  port: number;
  help: boolean;
};

function parseArguments(args: string[]): CliOptions {
  let host = DEFAULT_SERVER_HOST;
  let port = DEFAULT_SERVER_PORT;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
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
      if (!Number.isInteger(value)) throw new Error('--port 必须是整数。');
      port = value;
      continue;
    }
    throw new Error(`未知参数：${argument ?? ''}`);
  }
  return { host, port, help };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} 缺少参数。`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`DBAgent Headless MVP\n\n`);
  process.stdout.write(`用法：dbagent [--host 127.0.0.1] [--port 3721]\n`);
}
