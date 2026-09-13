import { createHash } from 'node:crypto';
import {
  PREPARED_TOOL_INTENT_REVISION,
  createRuntimeCommandToolResult,
  expectedToolError,
  type AgentToolPermissionFacts,
  type PreparedToolIntent,
  type RuntimeSkillActivation,
  type ToolInvocationContribution,
  type ToolPrepareContext,
} from '@dbagent/core-agent';
import {
  type SkillDocument,
  type SkillRegistry,
  type SkillRevisionRef,
  type SkillScope,
} from '@dbagent/core-skills';
import type { PortableValue } from '@dbagent/shared';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const TOOL_REVISION = 'skill.v1';
const MAX_QUERY_CHARS = 4_096;
const MAX_SKILL_NAME_CHARS = 256;
const MAX_SEARCH_RESULTS = 20;
const LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxInputBytes: 32 * 1024,
  maxOutputBytes: 256 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxDepth: 16,
  maxRecords: 2_000,
});

type SkillAction = 'search' | 'load';

/** Builds the Skill baseline handler for one immutable Turn-local catalog. */
export function createSkillToolContribution(skills: SkillRegistry): ToolInvocationContribution {
  const capturedSkills = skills.captureSnapshotView();
  const handlerRevision = skillToolHandlerRevision(capturedSkills);
  const revision = Object.freeze({
    toolName: 'skill',
    toolRevision: TOOL_REVISION,
    handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
  });
  return Object.freeze({
    definition: {
      name: 'skill',
      title: 'Use a Skill',
      aliases: [],
      tags: ['skill', 'instructions', 'workflow'],
      description:
        'Search available Skills or load one exact revision for the next Turn. Loaded instructions are returned through Runtime-owned result content.',
      inputSchema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'query'],
            properties: {
              action: { const: 'search' },
              query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS },
              scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
              limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'name'],
            properties: {
              action: { const: 'load' },
              name: { type: 'string', minLength: 1, maxLength: MAX_SKILL_NAME_CHARS },
              scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
            },
          },
        ],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'summary'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          summary: { type: 'string' },
          skills: {
            type: 'array',
            maxItems: MAX_SEARCH_RESULTS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'scope', 'score'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
                score: { type: 'number' },
              },
            },
          },
          name: { type: 'string' },
          description: { type: 'string' },
          scope: { type: 'string', enum: ['system', 'user', 'project', 'session'] },
          revision: { type: 'string' },
          appliesOn: { const: 'next_turn' },
          contentRef: { type: 'string', minLength: 1 },
        },
      },
      dangerLevel: 'safe',
      readonly: false,
      source: 'runtime',
      exposure: 'direct',
      permission: { actions: ['read', 'write'] },
      access: 'write',
      recoveryClass: 'idempotent',
      limits: LIMITS,
      toolRevision: TOOL_REVISION,
      handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'write', timeoutMs: LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      completion: { role: 'supporting', group: 'skill-activation' },
      presentation: {
        category: 'skill',
        preparingMessage: '正在使用项目 Skill。',
        inputPreview: { argument: 'name', label: 'Skill' },
      },
    },
    runtime: {
      revision,
      async prepare(input, context) {
        const action = skillAction(input.action);
        if (action === 'search') return prepareSearch(input, context);
        const scope = optionalScope(optionalString(input, 'scope'));
        const lookup = {
          name: boundedName(requireString(input, 'name')),
          ...(scope === undefined ? {} : { scope }),
        };
        const skill = await loadExpectedSkill(capturedSkills, lookup);
        return prepareLoad(skill, context);
      },
      async execute(input) {
        const action = skillAction(input.action);
        if (action === 'search') return searchSkills(capturedSkills, input);
        const revisionRef = input.revision as unknown as SkillRevisionRef;
        const skill = await loadExpectedRevision(capturedSkills, revisionRef);
        return createRuntimeCommandToolResult({
          command: {
            kind: 'skill.activate',
            payload: { activations: [runtimeSkillActivation(skill)] },
          },
          result: {
            status: 'ok',
            summary: `Skill ${skill.name} loaded for the next Turn.`,
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            revision: skill.revisionRef.revisionId,
            appliesOn: 'next_turn',
          },
          content: {
            body: skill.instructions,
            contentType: 'text/markdown; charset=utf-8',
            referenceField: 'contentRef',
          },
        });
      },
    },
  } satisfies ToolInvocationContribution);
}

function prepareSearch(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
): PreparedToolIntent {
  const query = boundedQuery(requireString(input, 'query'));
  const scope = optionalScope(optionalString(input, 'scope'));
  const limit = Math.min(optionalPositiveInteger(input, 'limit', 8) ?? 8, MAX_SEARCH_RESULTS);
  return intent({
    context,
    input: { action: 'search', query, limit, ...(scope === undefined ? {} : { scope }) },
    targetIdentity: null,
    permission: permissionFacts(context, 'read', 'read', true, ['read']),
    concurrency: 'read',
    resourceKeys: ['skills:catalog'],
    summary: `Search Skills for ${query}.`,
  });
}

function prepareLoad(skill: SkillDocument, context: ToolPrepareContext): PreparedToolIntent {
  const revision = structuredClone(skill.revisionRef) as unknown as PortableValue;
  return intent({
    context,
    input: { action: 'load', name: skill.name, scope: skill.scope, revision },
    targetIdentity: revision,
    permission: permissionFacts(context, 'write', 'idempotent', false, ['write'], [{
      kind: 'skill',
      name: skill.name,
      scope: skill.scope,
      revisionId: skill.revisionRef.revisionId,
    }]),
    concurrency: 'write',
    resourceKeys: [`skill:${context.runId}:${skill.scope}:${skill.name}`],
    summary: `Load Skill ${skill.name} at revision ${skill.revisionRef.revisionId}.`,
  });
}

function intent(input: Readonly<{
  context: ToolPrepareContext;
  input: Readonly<Record<string, PortableValue>>;
  targetIdentity: PortableValue;
  permission: AgentToolPermissionFacts;
  concurrency: 'read' | 'write';
  resourceKeys: readonly string[];
  summary: string;
}>): PreparedToolIntent {
  return Object.freeze({
    input: Object.freeze({ ...input.input }),
    toolRevision: input.context.toolRevision,
    handlerRevision: input.context.handlerRevision,
    intentRevision: input.context.intentRevision,
    targetIdentity: input.targetIdentity,
    generation: input.context.generation,
    action: { summary: input.summary },
    permission: input.permission,
    access: input.permission.access,
    recoveryClass: input.permission.recoveryClass,
    concurrency: input.concurrency,
    resourceKeys: Object.freeze([...input.resourceKeys]),
    limits: Object.freeze({ ...input.context.limits }),
  });
}

function searchSkills(
  registry: SkillRegistry,
  input: Readonly<Record<string, PortableValue>>,
): PortableValue {
  const scope = optionalScope(optionalString(input, 'scope'));
  const limit = Math.min(optionalPositiveInteger(input, 'limit', 8) ?? 8, MAX_SEARCH_RESULTS);
  const results = registry.search(boundedQuery(requireString(input, 'query')), {
    ...(scope === undefined ? {} : { scope }),
    limit,
  });
  return {
    status: 'ok',
    summary: `${results.length} Skill${results.length === 1 ? '' : 's'} matched.`,
    skills: results.map(({ skill, score }) => ({ ...skill, score })),
  };
}

function skillToolHandlerRevision(registry: SkillRegistry): string {
  const revisions = registry.list().map(({ name, scope }) => {
    const descriptor = registry.inspect({ name, scope });
    if (descriptor === undefined) throw new Error(`Captured Skill disappeared: ${scope}/${name}`);
    return `${scope}\0${name}\0${descriptor.revisionRef.revisionId}`;
  }).sort();
  const digest = createHash('sha256').update(JSON.stringify(revisions)).digest('hex');
  return `skill.handler.v1:${digest}`;
}

function runtimeSkillActivation(skill: SkillDocument): RuntimeSkillActivation {
  return {
    id: `skill:${skill.scope}:${skill.name}:${skill.revisionRef.revisionId}`,
    revision: structuredClone(skill.revisionRef),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: [...skill.allowedTools] }),
  };
}

function permissionFacts(
  context: ToolPrepareContext,
  access: 'read' | 'write',
  recoveryClass: 'read' | 'idempotent',
  readonly: boolean,
  actions: AgentToolPermissionFacts['actions'],
  targets: AgentToolPermissionFacts['targets'] = [],
): AgentToolPermissionFacts {
  return Object.freeze({
    toolName: context.descriptor.flatName,
    dangerLevel: 'safe',
    readonly,
    access,
    recoveryClass,
    actions,
    paths: [],
    hosts: [],
    network: false,
    externalWrite: false,
    destructive: false,
    credentials: false,
    admin: false,
    unknownRisk: false,
    resolvedAddresses: [],
    targets,
  });
}

function optionalScope(value: string | undefined): SkillScope | undefined {
  if (value === undefined) return undefined;
  if (value !== 'system' && value !== 'user' && value !== 'project' && value !== 'session') {
    throw expectedToolError('invalid_argument', 'The Skill scope is invalid.');
  }
  return value;
}

function skillAction(value: PortableValue | undefined): SkillAction {
  if (value === 'search' || value === 'load') return value;
  throw expectedToolError('invalid_argument', 'The Skill action must be search or load.');
}

function boundedQuery(value: string): string {
  const query = value.trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw expectedToolError('limit', `Skill query exceeds ${MAX_QUERY_CHARS} characters.`);
  }
  return query;
}

function boundedName(value: string): string {
  const name = value.trim();
  if (name.length > MAX_SKILL_NAME_CHARS) {
    throw expectedToolError('limit', `Skill name exceeds ${MAX_SKILL_NAME_CHARS} characters.`);
  }
  return name;
}

async function loadExpectedSkill(
  registry: SkillRegistry,
  lookup: { name: string; scope?: SkillScope },
): Promise<SkillDocument> {
  try {
    return await registry.load(lookup);
  } catch (error) {
    throw expectedSkillRegistryError(error);
  }
}

async function loadExpectedRevision(
  registry: SkillRegistry,
  revision: SkillRevisionRef,
): Promise<SkillDocument> {
  try {
    return await registry.loadRevision(revision);
  } catch (error) {
    throw expectedSkillRegistryError(error);
  }
}

function expectedSkillRegistryError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Unknown Skill registry failure.');
  if (/^Skill ".*" was not found/u.test(error.message) ||
      /^Skill revision .* is unavailable\./u.test(error.message)) {
    return expectedToolError('not_found', 'The requested Skill revision is unavailable.');
  }
  if (/requires unavailable capabilities/u.test(error.message)) {
    return expectedToolError('precondition', 'The Skill requires an unavailable Capability.');
  }
  return error;
}
