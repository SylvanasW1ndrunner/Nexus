import type { ToolRegistry } from '@dbagent/core-agent';
import type { WorkspaceCore, WorkspaceScriptTool } from '@dbagent/core-workspace';

export type WorkspaceScriptRunRequest = {
  rootPath: string;
  relativePath: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type WorkspaceScriptRunResult = {
  command?: string;
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

export type WorkspaceScriptRunner = (request: WorkspaceScriptRunRequest) => Promise<WorkspaceScriptRunResult>;

export type WorkspaceScriptToolDependencies = {
  registry: ToolRegistry;
  workspace: WorkspaceCore;
  getWorkspaceRoot: () => string | undefined;
  runner: WorkspaceScriptRunner;
  timeoutMs?: number;
};

export async function registerWorkspaceScriptTools(
  dependencies: WorkspaceScriptToolDependencies,
): Promise<WorkspaceScriptTool[]> {
  const { registry, workspace, getWorkspaceRoot, runner, timeoutMs } = dependencies;
  const rootPath = requireWorkspaceRoot(getWorkspaceRoot);
  const scriptTools = await workspace.discoverScriptTools(rootPath);

  for (const scriptTool of scriptTools) {
    registry.register(
      {
        name: scriptTool.name,
        description: scriptTool.description,
        inputSchema: scriptToolSchema(scriptTool),
        dangerLevel: 'medium',
        readonly: false,
      },
      async (args) =>
        runner({
          rootPath,
          relativePath: scriptTool.relativePath,
          args: normalizeScriptArgs(scriptTool, args),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
    );
  }

  return scriptTools;
}

function requireWorkspaceRoot(getWorkspaceRoot: () => string | undefined): string {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) throw new Error('No active workspace.');
  return rootPath;
}

function scriptToolSchema(scriptTool: WorkspaceScriptTool): Record<string, unknown> {
  const properties = Object.fromEntries(
    scriptTool.params.map((param) => [
      param.name,
      {
        type: jsonSchemaType(param.type),
        ...(param.description === undefined ? {} : { description: param.description }),
      },
    ]),
  );
  return {
    type: 'object',
    properties,
    required: scriptTool.params.map((param) => param.name),
  };
}

function normalizeScriptArgs(
  scriptTool: WorkspaceScriptTool,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const param of scriptTool.params) {
    const value = args[param.name];
    if (value === undefined) {
      throw new Error(`Tool argument "${param.name}" is required.`);
    }
    assertParamType(param, value);
    normalized[param.name] = value;
  }
  return normalized;
}

function assertParamType(param: WorkspaceScriptTool['params'][number], value: unknown): void {
  const type = param.type?.toLowerCase();
  if (!type || type === 'any') return;
  if ((type === 'str' || type === 'string') && typeof value !== 'string') {
    throw new Error(`Tool argument "${param.name}" must be a string.`);
  }
  if ((type === 'int' || type === 'integer') && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new Error(`Tool argument "${param.name}" must be an integer.`);
  }
  if ((type === 'float' || type === 'number') && typeof value !== 'number') {
    throw new Error(`Tool argument "${param.name}" must be a number.`);
  }
  if ((type === 'bool' || type === 'boolean') && typeof value !== 'boolean') {
    throw new Error(`Tool argument "${param.name}" must be a boolean.`);
  }
}

function jsonSchemaType(type?: string): string {
  const normalized = type?.toLowerCase();
  if (normalized === 'int' || normalized === 'integer') return 'integer';
  if (normalized === 'float' || normalized === 'number') return 'number';
  if (normalized === 'bool' || normalized === 'boolean') return 'boolean';
  if (normalized === 'object' || normalized === 'array') return normalized;
  return 'string';
}
