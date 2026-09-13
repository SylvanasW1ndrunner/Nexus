import type { PortableValue } from '@dbagent/shared';
import type { RuntimeCommand } from './kernel/runtime-command.js';
import { sealRuntimeCommandToolResult } from './internal/runtime-command-tool-result-authority.js';

type CommandIntent<C extends RuntimeCommand = RuntimeCommand> = C extends RuntimeCommand
  ? Readonly<Pick<C, 'kind' | 'payload'>>
  : never;

export type RuntimeCommandIntent = CommandIntent;

export type RuntimeCommandToolContent = Readonly<{
  /** Exact body retained by the Runtime; never projected inline. */
  body: string;
  contentType: string;
  /** Result field populated with the Runtime-issued contentRef. */
  referenceField: string;
}>;

declare const RUNTIME_COMMAND_TOOL_RESULT: unique symbol;

/**
 * Opaque Handler return understood only by ToolInvocationRuntime. It is not a
 * portable command envelope and cannot survive cloning or protocol transport.
 */
export type RuntimeCommandToolResult = Readonly<{
  [RUNTIME_COMMAND_TOOL_RESULT]: true;
}>;

export function createRuntimeCommandToolResult(input: Readonly<{
  command: RuntimeCommandIntent;
  result: PortableValue;
  content?: RuntimeCommandToolContent;
}>): RuntimeCommandToolResult {
  return sealRuntimeCommandToolResult(input.command, input.result, input.content);
}
