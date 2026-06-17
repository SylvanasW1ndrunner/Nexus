import type { WorkspaceScriptTool } from './types.js';

export function parseWorkspaceScriptTool(relativePath: string, content: string): WorkspaceScriptTool | undefined {
  const docstring = firstDocstring(content);
  if (!docstring) return undefined;
  const lines = docstring
    .split(/\r?\n/g)
    .map((line) => line.trim().replace(/^\*\s?/, ''))
    .filter(Boolean);
  const toolLine = lines.find((line) => /^DBAgent Tool:/i.test(line) || /^@tool\b/i.test(line));
  if (!toolLine) return undefined;

  const name = normalizeToolName(toolLine);
  if (!name) return undefined;

  const params = lines
    .filter((line) => /^@param\b/i.test(line))
    .map(parseParam)
    .filter((param): param is WorkspaceScriptTool['params'][number] => Boolean(param));
  const description =
    lines.find((line) => !/^DBAgent Tool:/i.test(line) && !/^@tool\b/i.test(line) && !/^@param\b/i.test(line)) ??
    `Workspace script tool ${name}`;

  return {
    name: `workspace_script:${name}`,
    description,
    relativePath,
    params,
  };
}

function firstDocstring(content: string): string | undefined {
  const tripleDouble = content.match(/^\s*"""([\s\S]*?)"""/);
  if (tripleDouble?.[1]) return tripleDouble[1];
  const tripleSingle = content.match(/^\s*'''([\s\S]*?)'''/);
  return tripleSingle?.[1];
}

function normalizeToolName(line: string): string | undefined {
  const raw = line.replace(/^DBAgent Tool:/i, '').replace(/^@tool/i, '').trim();
  return raw.match(/^[a-zA-Z_][a-zA-Z0-9_:-]*$/) ? raw : undefined;
}

function parseParam(line: string): WorkspaceScriptTool['params'][number] | undefined {
  const raw = line.replace(/^@param/i, '').trim();
  const match = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?::\s*([a-zA-Z0-9_\[\]|]+))?\s*(.*)$/);
  if (!match?.[1]) return undefined;
  return {
    name: match[1],
    ...(match[2] ? { type: match[2] } : {}),
    ...(match[3]?.trim() ? { description: match[3].trim() } : {}),
  };
}
