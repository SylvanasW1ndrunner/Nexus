import type { AgentSession, AgentToolContext, ToolRegistry } from '@dbagent/core-agent';
import {
  readSkillTextResource,
  type SkillDescriptor,
  type SkillRegistry,
  type SkillScope,
} from '@dbagent/core-skills';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type SessionSkillRegistryResolver = (session: AgentSession) => SkillRegistry;

type SkillSource = SkillRegistry | SessionSkillRegistryResolver;
type SkillAction = 'search' | 'load' | 'read_resource';

export type SkillToolOptions = {
  /** Runtime capability gate; metadata and rejection details remain outside model context. */
  isAvailable?: (descriptor: SkillDescriptor, context: AgentToolContext) => boolean;
};

export function registerSkillTools(
  registry: ToolRegistry,
  skills: SkillSource,
  options: SkillToolOptions = {},
): void {
  registry.register(
    {
      name: 'skill',
      title: 'Use a Skill',
      aliases: ['skills', 'workflow', '操作指引', '技能'],
      tags: ['skill', 'instructions', 'workflow'],
      description:
        'Search, activate, or read a resource from Markdown Skills. Search returns metadata only; load injects one selected Skill into the current Session.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'load', 'read_resource'] },
          query: { type: 'string' },
          name: { type: 'string' },
          scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
          path: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
          maxBytes: { type: 'integer', minimum: 1, maximum: 2_097_152 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
      exposure: 'direct',
      execution: { concurrency: 'write' },
      completion: { role: 'supporting', group: 'skill-activation' },
    },
    async (args, context) => {
      const action = skillAction(args.action);
      if (action === 'search') return searchSkills(skills, args, context, options);
      if (action === 'load') return loadSkill(skills, args, context, options);
      return readSkillResource(skills, args, context, options);
    },
  );

  // Kept for SDK compatibility. They are deliberately hidden from model
  // exposure so providers receive one stable Skill schema instead of three.
  registry.register(
    {
      name: 'skill_search',
      description: 'Legacy Skill catalog search entry.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
      exposure: 'hidden',
      execution: { concurrency: 'read' },
    },
    (args, context) => searchSkills(skills, args, context, options),
  );

  registry.register(
    {
      name: 'skill_load',
      description: 'Legacy Skill activation entry.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
        },
        required: ['name'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
      exposure: 'hidden',
      execution: { concurrency: 'write' },
    },
    (args, context) => loadSkill(skills, args, context, options),
  );

  registry.register(
    {
      name: 'skill_resource_read',
      description: 'Legacy activated Skill resource reader.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
          path: { type: 'string' },
          maxBytes: { type: 'integer', minimum: 1, maximum: 2_097_152 },
        },
        required: ['name', 'path'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
      exposure: 'hidden',
      execution: { concurrency: 'read' },
    },
    (args, context) => readSkillResource(skills, args, context, options),
  );
}

function searchSkills(
  source: SkillSource,
  args: Record<string, unknown>,
  context: AgentToolContext,
  options: SkillToolOptions,
) {
  const scope = optionalScope(optionalString(args, 'scope'));
  const requestedLimit = Math.min(optionalPositiveInteger(args, 'limit', 8) ?? 8, 20);
  const skillRegistry = resolveSkillRegistry(source, context.session);
  const results = skillRegistry.search(
    requireString(args, 'query'),
    {
      ...(scope === undefined ? {} : { scope }),
      limit: Math.max(requestedLimit, skillRegistry.list(scope ? { scope } : {}).length),
    },
  );
  return {
    skills: results
      .filter(({ skill }) => {
        const descriptor = skillRegistry.inspect(skill);
        return descriptor !== undefined && isAvailable(descriptor, context, options);
      })
      .slice(0, requestedLimit)
      .map(({ skill }) => skill),
  };
}

async function loadSkill(
  source: SkillSource,
  args: Record<string, unknown>,
  context: AgentToolContext,
  options: SkillToolOptions,
) {
  const scope = optionalScope(optionalString(args, 'scope'));
  const registry = resolveSkillRegistry(source, context.session);
  const lookup = {
    name: requireString(args, 'name'),
    ...(scope === undefined ? {} : { scope }),
  };
  const descriptor = registry.inspect(lookup);
  if (!descriptor) throw new Error(`Skill not found: ${lookup.name}.`);
  assertAvailable(descriptor, context, options);
  const skill = await registry.load(lookup);
  const active = new Map(
    (context.session.activeSkills ?? []).map((item) => [`${item.scope}:${item.name}`, item]),
  );
  active.set(`${skill.scope}:${skill.name}`, {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    instructions: skill.instructions,
  });
  context.session.activeSkills = [...active.values()];
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    instructions: skill.instructions,
  };
}

async function readSkillResource(
  source: SkillSource,
  args: Record<string, unknown>,
  context: AgentToolContext,
  options: SkillToolOptions,
) {
  const scope = optionalScope(optionalString(args, 'scope'));
  const lookup = {
    name: requireString(args, 'name'),
    ...(scope === undefined ? {} : { scope }),
  };
  const descriptor = resolveSkillRegistry(source, context.session).inspect(lookup);
  if (!descriptor) throw new Error(`Skill not found: ${lookup.name}.`);
  assertAvailable(descriptor, context, options);
  const activated = (context.session.activeSkills ?? []).some(
    (skill) => skill.name === descriptor.name && skill.scope === descriptor.scope,
  );
  if (!activated) {
    throw new Error(
      `Skill must be activated before reading resources: ${descriptor.scope}:${descriptor.name}.`,
    );
  }
  const path = requireString(args, 'path');
  const content = await readSkillTextResource(descriptor, path, {
    maxBytes: Math.min(
      optionalPositiveInteger(args, 'maxBytes', 256 * 1024) ?? 256 * 1024,
      2 * 1024 * 1024,
    ),
  });
  return { name: descriptor.name, scope: descriptor.scope, path, content };
}

function isAvailable(
  descriptor: SkillDescriptor,
  context: AgentToolContext,
  options: SkillToolOptions,
): boolean {
  return options.isAvailable?.(descriptor, context) ?? true;
}

function assertAvailable(
  descriptor: SkillDescriptor,
  context: AgentToolContext,
  options: SkillToolOptions,
): void {
  if (!isAvailable(descriptor, context, options)) {
    throw new Error(`Skill is not available for the current capability set: ${descriptor.name}.`);
  }
}

function resolveSkillRegistry(source: SkillSource, session: AgentSession): SkillRegistry {
  return typeof source === 'function' ? source(session) : source;
}

function optionalScope(value: string | undefined): SkillScope | undefined {
  if (value === undefined) return undefined;
  if (!['system', 'user', 'project', 'session'].includes(value)) {
    throw new Error(`Unsupported Skill scope: ${value}.`);
  }
  return value as SkillScope;
}

function skillAction(value: unknown): SkillAction {
  if (value === 'search' || value === 'load' || value === 'read_resource') return value;
  throw new Error(`Unsupported Skill action: ${String(value)}.`);
}
