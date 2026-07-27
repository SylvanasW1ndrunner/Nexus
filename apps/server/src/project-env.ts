import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type ProjectEnvLoadResult = {
  loaded: boolean;
  path: string;
  keys: string[];
};

export class ProjectEnvError extends Error {
  readonly code = 'PROJECT_ENV_INVALID';
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, reason: string) {
    super(`Invalid Project .env at line ${line}: ${reason}`);
    this.name = 'ProjectEnvError';
    this.path = path;
    this.line = line;
  }
}

/**
 * Loads `<projectDirectory>/.env` without overriding values already present in
 * the host process. Error messages identify the line and failure category but
 * never include the source line or its value.
 */
export async function loadProjectEnv(
  projectDirectory: string,
  target: NodeJS.ProcessEnv = process.env,
): Promise<ProjectEnvLoadResult> {
  const path = resolve(projectDirectory, '.env');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { loaded: false, path, keys: [] };
    }
    throw error;
  }

  const parsed = new Map<string, string>();
  for (const [index, sourceLine] of source.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    let line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ProjectEnvError(path, lineNumber, 'expected KEY=VALUE');
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new ProjectEnvError(path, lineNumber, 'invalid variable name');
    }
    parsed.set(key, parseValue(line.slice(separator + 1).trim(), path, lineNumber));
  }

  for (const [key, value] of parsed) {
    if (target[key] === undefined) target[key] = value;
  }
  return { loaded: true, path, keys: [...parsed.keys()] };
}

function parseValue(value: string, path: string, line: number): string {
  if (!value) return '';
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return stripUnquotedComment(value);
  if (value.length < 2 || value.at(-1) !== quote) {
    throw new ProjectEnvError(path, line, 'unterminated quoted value');
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\([nrt"\\])/gu, (_match, escaped: string) => {
    switch (escaped) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return escaped;
    }
  });
}

function stripUnquotedComment(value: string): string {
  const comment = value.search(/\s#/u);
  return (comment < 0 ? value : value.slice(0, comment)).trimEnd();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
