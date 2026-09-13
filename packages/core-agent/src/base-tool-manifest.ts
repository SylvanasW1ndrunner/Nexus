/** Build-owned schema revisions; bump the entry whenever its public schema changes. */
export const BASE_TOOL_MANIFEST = Object.freeze([
  { name: 'ask_user', schemaRevision: 'ask_user.v1' },
  { name: 'tool_search', schemaRevision: 'tool_search.v1' },
  { name: 'result_read', schemaRevision: 'result_read.v1' },
  { name: 'result_materialize', schemaRevision: 'result_materialize.v1' },
  { name: 'result_save', schemaRevision: 'result_save.v1' },
  { name: 'skill', schemaRevision: 'skill.v1' },
  { name: 'workspace_list', schemaRevision: 'workspace_list.v1' },
  { name: 'workspace_read', schemaRevision: 'workspace_read.v1' },
  { name: 'workspace_search', schemaRevision: 'workspace_search.v1' },
  { name: 'workspace_apply_patch', schemaRevision: 'workspace_apply_patch.v1' },
  { name: 'process_exec', schemaRevision: 'process_exec.v1' },
  { name: 'process_control', schemaRevision: 'process_control.v1' },
  { name: 'web_search', schemaRevision: 'web_search.v1' },
  { name: 'web_fetch', schemaRevision: 'web_fetch.v1' },
] as const).map((entry) => Object.freeze(entry));
Object.freeze(BASE_TOOL_MANIFEST);

export type BaseToolName = (typeof BASE_TOOL_MANIFEST)[number]['name'];
const baseToolNames: ReadonlySet<string> = new Set(BASE_TOOL_MANIFEST.map(({ name }) => name));

export function isBaseToolName(name: string): name is BaseToolName {
  return baseToolNames.has(name);
}
