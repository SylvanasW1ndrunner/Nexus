import { SKILL_SCOPES } from './types.js';
import type { SkillInvocation, SkillScope } from './types.js';

const NAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/;
const RESERVED_COMMANDS = new Set([
  'agent',
  'compact',
  'help',
  'init',
  'mcp',
  'permissions',
  'session',
  'skills',
]);

/**
 * Parses `/skill-name args` and `/project:skill-name args`.
 *
 * Reserved CLI commands intentionally do not resolve as Skills. Inline
 * `$skill-name` mentions are handled by the Agent's normal message parser.
 */
export function parseSkillInvocation(input: string): SkillInvocation | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined;
  const separator = trimmed.search(/\s/);
  const command = trimmed.slice(1, separator < 0 ? undefined : separator);
  const argumentsText = separator < 0 ? '' : trimmed.slice(separator).trim();
  if (!command) return undefined;

  const colon = command.indexOf(':');
  const scopeText = colon < 0 ? undefined : command.slice(0, colon);
  const name = colon < 0 ? command : command.slice(colon + 1);
  if (!NAME_PATTERN.test(name)) return undefined;
  if (!scopeText && RESERVED_COMMANDS.has(name)) return undefined;
  if (scopeText && !isScope(scopeText)) return undefined;
  const scope: SkillScope | undefined = scopeText && isScope(scopeText) ? scopeText : undefined;

  return {
    name,
    ...(scope === undefined ? {} : { scope }),
    arguments: argumentsText,
    raw: input,
  };
}

function isScope(value: string): value is SkillScope {
  return (SKILL_SCOPES as readonly string[]).includes(value);
}
