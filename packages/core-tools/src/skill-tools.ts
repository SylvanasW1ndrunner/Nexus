import type { AgentSession, ToolRegistry } from '@dbagent/core-agent';
import { readSkillTextResource, type SkillRegistry, type SkillScope } from '@dbagent/core-skills';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type SessionSkillRegistryResolver = (session: AgentSession) => SkillRegistry;

export function registerSkillTools(
  registry: ToolRegistry,
  skills: SkillRegistry | SessionSkillRegistryResolver,
): void {
  registry.register(
    {
      name: 'skill_search',
      description:
        'Search the lightweight Skill catalog. Skill instructions are loaded only after selecting a relevant Skill.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: {
            type: 'string',
            enum: ['system', 'user', 'project', 'session'],
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
    },
    (args, context) => {
      const scope = optionalScope(optionalString(args, 'scope'));
      const results = resolveSkillRegistry(skills, context.session).search(
        requireString(args, 'query'),
        {
          ...(scope === undefined ? {} : { scope }),
          limit: Math.min(optionalPositiveInteger(args, 'limit', 8) ?? 8, 20),
        },
      );
      return {
        skills: results.map(({ skill }) => skill),
      };
    },
  );

  registry.register(
    {
      name: 'skill_load',
      description:
        'Activate one relevant SKILL.md and return its instructions. Do not load unrelated Skills.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          scope: {
            type: 'string',
            enum: ['system', 'user', 'project', 'session'],
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
    },
    async (args, context) => {
      const scope = optionalScope(optionalString(args, 'scope'));
      const skill = await resolveSkillRegistry(skills, context.session).load({
        name: requireString(args, 'name'),
        ...(scope === undefined ? {} : { scope }),
      });
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
    },
  );

  registry.register(
    {
      name: 'skill_resource_read',
      description:
        'Read a text resource referenced by an activated Skill, bounded to that Skill directory.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          scope: {
            type: 'string',
            enum: ['system', 'user', 'project', 'session'],
          },
          path: { type: 'string' },
          maxBytes: { type: 'integer', minimum: 1, maximum: 2097152 },
        },
        required: ['name', 'path'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'skill',
    },
    async (args, context) => {
      const scope = optionalScope(optionalString(args, 'scope'));
      const lookup = {
        name: requireString(args, 'name'),
        ...(scope === undefined ? {} : { scope }),
      };
      const descriptor = resolveSkillRegistry(skills, context.session).inspect(lookup);
      if (!descriptor) throw new Error(`Skill not found: ${lookup.name}.`);
      const activated = (context.session.activeSkills ?? []).some(
        (skill) => skill.name === descriptor.name && skill.scope === descriptor.scope,
      );
      if (!activated) {
        throw new Error(
          `Skill must be activated with skill_load before reading resources: ${descriptor.scope}:${descriptor.name}.`,
        );
      }
      const content = await readSkillTextResource(descriptor, requireString(args, 'path'), {
        maxBytes: Math.min(
          optionalPositiveInteger(args, 'maxBytes', 256 * 1024) ?? 256 * 1024,
          2 * 1024 * 1024,
        ),
      });
      return { name: descriptor.name, path: requireString(args, 'path'), content };
    },
  );
}

function resolveSkillRegistry(
  source: SkillRegistry | SessionSkillRegistryResolver,
  session: AgentSession,
): SkillRegistry {
  return typeof source === 'function' ? source(session) : source;
}

function optionalScope(value: string | undefined): SkillScope | undefined {
  if (value === undefined) return undefined;
  if (!['system', 'user', 'project', 'session'].includes(value)) {
    throw new Error(`Unsupported Skill scope: ${value}.`);
  }
  return value as SkillScope;
}
