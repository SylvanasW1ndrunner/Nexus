import type { ToolRegistry } from '@dbagent/core-agent';
import type { WorkspaceCore } from '@dbagent/core-workspace';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type WorkspaceToolDependencies = {
  registry: ToolRegistry;
  workspace: WorkspaceCore;
  getWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
};

export function registerWorkspaceTools(dependencies: WorkspaceToolDependencies): void {
  const { registry, workspace, getWorkspaceRoot } = dependencies;

  registry.register(
    {
      name: 'list_workspace_dir',
      description: 'List files and directories under the active workspace. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const relativePath = optionalString(args, 'path') ?? '.';
      return {
        entries: await workspace.listFiles(rootPath, relativePath),
      };
    },
  );

  registry.register(
    {
      name: 'read_workspace_file',
      description: 'Read a UTF-8 text file from the active workspace. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        maxBytes: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const maxBytes = optionalPositiveInteger(args, 'maxBytes', 1024 * 1024);
      const content = await workspace.readFile(rootPath, path, maxBytes);
      return {
        path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    },
  );

  registry.register(
    {
      name: 'write_workspace_file',
      description:
        'Write a UTF-8 text file inside the active workspace using the workspace atomic-write boundary. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        content: { type: 'string' },
      }),
      dangerLevel: 'medium',
      readonly: false,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const content = requireString(args, 'content');
      return workspace.writeFile(rootPath, path, content);
    },
  );
}

async function requireWorkspaceRoot(
  getWorkspaceRoot: () => string | undefined | Promise<string | undefined>,
): Promise<string> {
  const rootPath = await getWorkspaceRoot();
  if (!rootPath) throw new Error('No active workspace.');
  return rootPath;
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}
