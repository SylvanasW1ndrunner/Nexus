import {
  PREPARED_TOOL_INTENT_REVISION,
  LexicalToolSearchIndex,
  compareUnicodeCodePoints,
  createRuntimeCommandToolResult,
  expectedToolError,
  isBaseToolName,
  type AgentCapabilityDiscoveryManifestEntry,
  type AgentCapabilityActivationBinding,
  type AgentToolDescriptor,
  type AgentToolPermissionFacts,
  type PreparedToolIntent,
  type RuntimeCapabilityDiscoveryTarget,
  type RuntimeCapabilityActivationBinding,
  type RuntimeToolActivation,
  type ToolExecuteContext,
  type ToolInvocationContribution,
  type ToolPrepareContext,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';

const MAX_QUERY_CHARS = 4_096;
const MAX_SELECTIONS = 20;
const MAX_PROBE_REF_CHARS = 2_048;
const LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
  maxArtifactBytes: 256 * 1024,
  maxDepth: 16,
  maxRecords: 2_000,
});

export type ToolSearchCapabilityActivationResult = Readonly<{
  status: 'activated' | 'unavailable' | 'denied';
  reason?: string;
  binding?: AgentCapabilityActivationBinding;
}>;

/** Host-owned bridge; it may probe external state but never accepts config values. */
export type ToolSearchCapabilityActivator = Readonly<{
  revision: string;
  activate(input: Readonly<{
    name: string;
    target: RuntimeCapabilityDiscoveryTarget;
    probeChoiceRef?: string;
    hostId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    signal: AbortSignal;
    deadline: string;
  }>): Promise<ToolSearchCapabilityActivationResult>;
}>;

export type ToolSearchToolOptions = Readonly<{
  capabilityActivator?: ToolSearchCapabilityActivator;
}>;

type PreparedSelection = Readonly<{
  name: string;
  kind: 'tool' | 'capability' | 'direct' | 'active_capability' | 'not_found' | 'denied';
  toolRevision?: string;
  handlerRevision?: string;
  target?: RuntimeCapabilityDiscoveryTarget;
  availability?: AgentCapabilityDiscoveryManifestEntry['status'];
  reason?: string;
  probeChoiceRef?: string;
  bindingRequired?: true;
}>;

export function createToolSearchToolContribution(
  options: ToolSearchToolOptions = {},
): ToolInvocationContribution {
  const activatorRevision = boundedRevision(
    options.capabilityActivator?.revision ?? 'capability-activator.unavailable.v1',
  );
  const handlerRevision = `tool_search.handler.v2:${digestRevision(activatorRevision)}`;
  return Object.freeze({
    definition: {
      name: 'tool_search',
      description:
        'Search deferred Tools and Capability tool sets, or select known names for the next Turn. A query only returns matches; call tool_search again with select to activate a matched Capability or Tool.',
      aliases: [],
      tags: ['tools', 'discovery', 'capability'],
      inputSchema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: {
              query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS },
              limit: { type: 'integer', minimum: 1, maximum: MAX_SELECTIONS },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['select'],
            properties: {
              select: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_SELECTIONS,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 256 },
                    probeChoiceRef: {
                      type: 'string', minLength: 1, maxLength: MAX_PROBE_REF_CHARS,
                    },
                  },
                },
              },
            },
          },
        ],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'summary'],
        properties: {
          status: { const: 'ok' },
          summary: { type: 'string' },
          matches: {
            type: 'array', maxItems: MAX_SELECTIONS,
            items: {
              type: 'object', additionalProperties: false,
              required: ['kind', 'name', 'description', 'score'],
              properties: {
                kind: { type: 'string', enum: ['tool', 'capability'] },
                name: { type: 'string' }, description: { type: 'string' },
                score: { type: 'number' }, availability: {
                  type: 'string',
                  enum: ['unloaded', 'available', 'unavailable', 'degraded', 'disabled'],
                },
                reason: { type: 'string' },
                choices: {
                  type: 'array', maxItems: 20,
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['candidateId', 'label', 'probeChoiceRef'],
                    properties: {
                      candidateId: { type: 'string' }, label: { type: 'string' },
                      description: { type: 'string' }, metadata: { type: 'object' },
                      probeChoiceRef: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          selections: {
            type: 'array', maxItems: MAX_SELECTIONS,
            items: {
              type: 'object', additionalProperties: false,
              required: ['kind', 'name', 'status'],
              properties: {
                kind: { type: 'string', enum: ['tool', 'capability', 'unknown'] },
                name: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['activated', 'unavailable', 'not_found', 'denied'],
                },
                appliesOn: { const: 'next_turn' }, reason: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
          omittedCount: { type: 'integer', minimum: 0 },
          omittedReason: { type: 'string' },
        },
      },
      dangerLevel: 'medium',
      readonly: false,
      source: 'runtime',
      exposure: 'direct',
      permission: { actions: ['read', 'write', 'unknown'] },
      access: 'external',
      recoveryClass: 'idempotent',
      limits: LIMITS,
      toolRevision: 'tool_search.v1',
      handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'tools', preparingMessage: '正在查找可用工具。' },
    },
    runtime: {
      revision: {
        toolName: 'tool_search',
        toolRevision: 'tool_search.v1',
        handlerRevision,
        intentRevision: PREPARED_TOOL_INTENT_REVISION,
      },
      prepare(input, context) {
        if (Object.hasOwn(input, 'query')) return prepareQuery(input, context);
        return prepareSelection(input, context, activatorRevision);
      },
      async execute(input, context) {
        if (input.action === 'query') return queryCatalog(input, context);
        return await activateSelections(input, context, options.capabilityActivator);
      },
    },
  } satisfies ToolInvocationContribution);
}

function prepareQuery(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
): PreparedToolIntent {
  const query = requiredText(input.query, 'query', MAX_QUERY_CHARS);
  const limit = boundedInteger(input.limit, 5, 1, MAX_SELECTIONS);
  return intent({
    context,
    input: { action: 'query', query, limit },
    targetIdentity: null,
    permission: permission(context, 'read', 'read', true, ['read']),
    concurrency: 'read',
    resourceKeys: ['discovery:catalog'],
    summary: `Search the captured Tool catalog for ${query}.`,
  });
}

function prepareSelection(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
  activatorRevision: string,
): PreparedToolIntent {
  const requested = selectionInput(input.select);
  const active = new Map(
    (context.runtimeState?.activeTools ?? []).map((activation) => [activation.name, activation]),
  );
  const activeCapabilityTargets = new Set(
    (context.runtimeState?.discoveredCapabilities ?? []).map(capabilityTargetKey),
  );
  const prepared = requested.map(({ name, probeChoiceRef }): PreparedSelection => {
    const tools = context.discoverableTools.filter(({ flatName }) => flatName === name);
    const capabilities = context.discoverableCapabilities.filter((candidate) => candidate.name === name);
    if (tools.length > 0 && capabilities.length > 0 || tools.length > 1 || capabilities.length > 1) {
      return { name, kind: 'denied', reason: 'The selected name is ambiguous in this Turn.' };
    }
    const tool = tools[0];
    if (tool !== undefined) {
      const activeRevision = active.get(name);
      if (
        isBaseToolName(name) || tool.exposure === 'direct' ||
        activeRevision?.toolRevision === tool.toolRevision &&
          activeRevision.handlerRevision === tool.handlerRevision
      ) {
        return {
          name,
          kind: 'direct',
          toolRevision: tool.toolRevision,
          handlerRevision: tool.handlerRevision,
        };
      }
      if (tool.exposure !== 'deferred') {
        return { name, kind: 'denied', reason: 'The Tool is not eligible for discovery.' };
      }
      return {
        name,
        kind: 'tool',
        toolRevision: tool.toolRevision,
        handlerRevision: tool.handlerRevision,
      };
    }
    const capability = capabilities[0];
    if (capability === undefined) return { name, kind: 'not_found' };
    if (activeCapabilityTargets.has(capabilityTargetKey(capability.target))) {
      return { name, kind: 'active_capability' };
    }
    return {
      name,
      kind: 'capability',
      target: structuredClone(capability.target),
      availability: capability.status,
      ...(capability.reason === undefined ? {} : { reason: capability.reason }),
      ...(probeChoiceRef === undefined ? {} : { probeChoiceRef }),
      ...(capability.activation === undefined ? {} : { bindingRequired: true }),
    };
  });
  const hasCapability = prepared.some(({ kind }) => kind === 'capability');
  const facts = hasCapability
    ? permission(context, 'external', 'idempotent', false, ['unknown'], prepared.map(({ name, kind }) => ({ kind: 'discovery-selection', name, selectionKind: kind })), true)
    : permission(context, 'write', 'idempotent', false, ['write'], prepared.map(({ name, kind }) => ({ kind: 'discovery-selection', name, selectionKind: kind })));
  return intent({
    context,
    input: {
      action: 'select',
      activatorRevision,
      selections: structuredClone(prepared),
    },
    // The selected catalog entries and activator generation are already
    // immutable prepared input.  Capability availability is re-probed by the
    // activator itself; there is no separate mutable filesystem/network target
    // for the generic boundary revalidator.
    targetIdentity: null,
    permission: facts,
    concurrency: hasCapability ? 'exclusive' : 'write',
    resourceKeys: hasCapability ? [] : prepared.map(({ name }) => `discovery:${name}`),
    summary: `Select ${prepared.length} captured Tool or Capability name${prepared.length === 1 ? '' : 's'}.`,
  });
}

function queryCatalog(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
): PortableValue {
  const query = requiredText(input.query, 'query', MAX_QUERY_CHARS);
  const limit = boundedInteger(input.limit, 5, 1, MAX_SELECTIONS);
  const active = new Map(
    (context.runtimeState?.activeTools ?? []).map((activation) => [activation.name, activation]),
  );
  const activeCapabilityTargets = new Set(
    (context.runtimeState?.discoveredCapabilities ?? []).map(capabilityTargetKey),
  );
  const candidates: Array<Readonly<{
    descriptor: AgentToolDescriptor;
    kind: 'tool' | 'capability';
    capability?: AgentCapabilityDiscoveryManifestEntry;
  }>> = [
    ...context.discoverableTools
      .filter((descriptor) =>
        {
          const { flatName, exposure, toolRevision, handlerRevision } = descriptor;
          const activation = active.get(flatName);
          return (
        !isBaseToolName(flatName) && exposure === 'deferred' && !(
              activation?.toolRevision === toolRevision &&
              activation.handlerRevision === handlerRevision
            )
          );
        })
      .map((descriptor) => ({ descriptor, kind: 'tool' as const })),
    ...context.discoverableCapabilities
      .filter((capability) => !activeCapabilityTargets.has(capabilityTargetKey(capability.target)))
      .map((capability) => ({
        descriptor: capabilitySearchDescriptor(capability),
        kind: 'capability' as const,
        capability,
      })),
  ].sort((left, right) =>
    compareUnicodeCodePoints(left.descriptor.flatName, right.descriptor.flatName) ||
    compareUnicodeCodePoints(left.kind, right.kind));
  const byDescriptor = new Map(candidates.map((candidate) => [candidate.descriptor, candidate]));
  const page = new LexicalToolSearchIndex(candidates.map(({ descriptor }) => descriptor))
    .searchPage(query, { limit });
  const matches = page.matches.map(({ tool, score }) => {
    const candidate = byDescriptor.get(tool);
    if (candidate === undefined) throw new Error('Tool search index returned an unknown entry.');
    const capability = candidate.capability;
    return {
      kind: candidate.kind,
      name: tool.flatName,
      description: tool.description,
      score,
      ...(capability === undefined ? {} : { availability: capability.status }),
      ...(capability?.reason === undefined ? {} : { reason: capability.reason }),
      ...(capability?.activation === undefined ||
        capability.activation.selection !== 'choice_required' ||
        !capability.activation.candidates.every(({ probeChoiceRef }) => probeChoiceRef !== undefined)
        ? {}
        : {
            choices: capability.activation.candidates.map((choice) => ({
              candidateId: choice.candidateId,
              label: choice.label,
              ...(choice.description === undefined ? {} : { description: choice.description }),
              ...(choice.metadata === undefined ? {} : { metadata: choice.metadata }),
              probeChoiceRef: choice.probeChoiceRef!,
            })),
          }),
    };
  });
  const omittedCount = Math.max(0, page.totalMatches - matches.length);
  return {
    status: 'ok',
    summary: `${matches.length} matching Tool or Capability entr${matches.length === 1 ? 'y' : 'ies'} found.`,
    matches,
    truncated: omittedCount > 0,
    omittedCount,
    ...(omittedCount === 0 ? {} : { omittedReason: 'query_limit' }),
  };
}

async function activateSelections(
  input: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
  activator: ToolSearchCapabilityActivator | undefined,
): Promise<PortableValue | ReturnType<typeof createRuntimeCommandToolResult>> {
  const selections = preparedSelections(input.selections);
  const activatedTools: RuntimeToolActivation[] = [];
  const activatedTargets: RuntimeCapabilityDiscoveryTarget[] = [];
  const activationBindings: RuntimeCapabilityActivationBinding[] = [];
  const capabilityActivations = new Map<string, Readonly<{
    probeChoiceRef?: string;
    result: ToolSearchCapabilityActivationResult;
  }>>();
  const results: Array<Record<string, PortableValue>> = [];
  for (const selection of selections) {
    assertActive(context);
    if (selection.kind === 'not_found') {
      results.push({ kind: 'unknown', name: selection.name, status: 'not_found' });
      continue;
    }
    if (selection.kind === 'denied') {
      results.push({ kind: 'unknown', name: selection.name, status: 'denied', reason: selection.reason ?? 'Selection denied.' });
      continue;
    }
    if (selection.kind === 'direct') {
      results.push({ kind: 'tool', name: selection.name, status: 'activated', appliesOn: 'next_turn', reason: 'already_active' });
      continue;
    }
    if (selection.kind === 'active_capability') {
      results.push({ kind: 'capability', name: selection.name, status: 'activated', appliesOn: 'next_turn', reason: 'already_active' });
      continue;
    }
    if (selection.kind === 'tool') {
      activatedTools.push({
        name: selection.name,
        toolRevision: selection.toolRevision!,
        handlerRevision: selection.handlerRevision!,
      });
      results.push({ kind: 'tool', name: selection.name, status: 'activated', appliesOn: 'next_turn' });
      continue;
    }
    if (selection.availability === 'unavailable' || selection.availability === 'disabled') {
      results.push({
        kind: 'capability', name: selection.name, status: 'unavailable',
        reason: selection.reason ?? `Capability is ${selection.availability}.`,
      });
      continue;
    }
    if (activator === undefined || activator.revision !== input.activatorRevision) {
      results.push({ kind: 'capability', name: selection.name, status: 'unavailable', reason: 'Capability activation backend is unavailable.' });
      continue;
    }
    const targetKey = capabilityTargetKey(selection.target!);
    const cached = capabilityActivations.get(targetKey);
    if (cached !== undefined && cached.probeChoiceRef !== selection.probeChoiceRef) {
      results.push({
        kind: 'capability', name: selection.name, status: 'denied',
        reason: 'One module instance cannot use different external context choices in the same selection.',
      });
      continue;
    }
    let activation = cached?.result;
    if (activation === undefined) {
      try {
        activation = activationResult(await activator.activate({
          name: selection.name,
          target: selection.target!,
          ...(selection.probeChoiceRef === undefined ? {} : { probeChoiceRef: selection.probeChoiceRef }),
          hostId: context.hostId,
          projectId: context.projectId,
          sessionId: context.sessionId,
          runId: context.runId,
          signal: context.signal,
          deadline: context.deadline,
        }));
      } catch {
        if (context.signal.aborted) throw new Error('Capability activation was cancelled.');
        activation = { status: 'unavailable', reason: 'Capability activation failed; inspect the external prerequisite and retry.' };
      }
      capabilityActivations.set(targetKey, {
        ...(selection.probeChoiceRef === undefined ? {} : { probeChoiceRef: selection.probeChoiceRef }),
        result: activation,
      });
    }
    const reason = boundedReason(activation.reason);
    if (
      activation.status === 'activated' &&
      selection.bindingRequired === true &&
      activation.binding === undefined
    ) {
      results.push({
        kind: 'capability', name: selection.name, status: 'unavailable',
        reason: 'Capability choice validation did not produce a durable activation binding.',
      });
      continue;
    }
    // An unloaded Capability may discover an automatic external-context
    // binding only when activation performs its first bounded probe. The
    // trusted activator owns and validates that binding, so accept it even
    // when the Turn's metadata-only manifest could not require it in advance.
    if (activation.status === 'activated') {
      if (cached === undefined) {
        activatedTargets.push(selection.target!);
        if (activation.binding !== undefined) {
          activationBindings.push({ target: selection.target!, binding: activation.binding });
        }
      }
      results.push({ kind: 'capability', name: selection.name, status: 'activated', appliesOn: 'next_turn', ...(reason === undefined ? {} : { reason }) });
    } else {
      results.push({ kind: 'capability', name: selection.name, status: activation.status, ...(reason === undefined ? {} : { reason }) });
    }
  }
  const result: PortableValue = {
    status: 'ok',
    summary: `${results.filter(({ status }) => status === 'activated').length} of ${results.length} selections activated.`,
    selections: results,
  };
  const tools = uniqueToolActivations(activatedTools);
  const targets = uniqueTargets(activatedTargets);
  return tools.length === 0 && targets.length === 0
    ? result
    : createRuntimeCommandToolResult({
        command: {
          kind: 'discovery.activate',
          payload: {
            tools,
            targets,
            bindings: uniqueCapabilityBindings(activationBindings),
          },
        },
        result,
      });
}

function intent(input: Readonly<{
  context: ToolPrepareContext;
  input: Readonly<Record<string, PortableValue>>;
  targetIdentity: PortableValue;
  permission: AgentToolPermissionFacts;
  concurrency: 'read' | 'write' | 'exclusive';
  resourceKeys: readonly string[];
  summary: string;
}>): PreparedToolIntent {
  return {
    input: input.input,
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
    resourceKeys: input.resourceKeys,
    limits: input.context.limits,
  };
}

function permission(
  context: ToolPrepareContext,
  access: AgentToolPermissionFacts['access'],
  recoveryClass: AgentToolPermissionFacts['recoveryClass'],
  readonly: boolean,
  actions: AgentToolPermissionFacts['actions'],
  targets: AgentToolPermissionFacts['targets'] = [],
  unknownRisk = false,
): AgentToolPermissionFacts {
  return {
    toolName: context.descriptor.flatName,
    dangerLevel: unknownRisk ? 'medium' : 'safe',
    readonly,
    access,
    recoveryClass,
    actions,
    paths: [], hosts: [], network: false, externalWrite: false,
    destructive: false, credentials: false, admin: false, unknownRisk,
    resolvedAddresses: [], targets,
  };
}

function selectionInput(value: PortableValue | undefined): Array<{ name: string; probeChoiceRef?: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTIONS) {
    throw expectedToolError('invalid_argument', `select must contain 1-${MAX_SELECTIONS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw expectedToolError('invalid_argument', 'Each select entry must be an object.');
    }
    const record = candidate as Record<string, PortableValue>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== 'name' && key !== 'probeChoiceRef')) {
      throw expectedToolError('invalid_argument', 'A select entry contains an unsupported field.');
    }
    const name = requiredText(record.name, 'select.name', 256);
    if (seen.has(name)) throw expectedToolError('invalid_argument', `Duplicate Tool selection: ${name}.`);
    seen.add(name);
    const probeChoiceRef = record.probeChoiceRef === undefined
      ? undefined
      : requiredText(record.probeChoiceRef, 'select.probeChoiceRef', MAX_PROBE_REF_CHARS);
    return { name, ...(probeChoiceRef === undefined ? {} : { probeChoiceRef }) };
  });
}

function preparedSelections(value: PortableValue | undefined): PreparedSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTIONS) {
    throw expectedToolError('precondition', 'Prepared selections are invalid.');
  }
  return value.map((candidate): PreparedSelection => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw expectedToolError('precondition', 'Prepared selection is invalid.');
    }
    const record = candidate as Record<string, PortableValue>;
    const kind = record.kind;
    if (
      kind !== 'tool' && kind !== 'capability' && kind !== 'direct' &&
      kind !== 'active_capability' &&
      kind !== 'not_found' && kind !== 'denied'
    ) {
      throw expectedToolError('precondition', 'Prepared selection kind is invalid.');
    }
    const allowed = kind === 'capability'
      ? ['name', 'kind', 'target', 'availability', 'reason', 'probeChoiceRef', 'bindingRequired']
      : kind === 'tool' || kind === 'direct'
        ? ['name', 'kind', 'toolRevision', 'handlerRevision']
        : ['name', 'kind', 'reason'];
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
      throw expectedToolError('precondition', 'Prepared selection contains unsupported fields.');
    }
    const name = requiredText(record.name, 'prepared.name', 256);
    if (kind === 'tool' || kind === 'direct') {
      return {
        name,
        kind,
        toolRevision: requiredText(record.toolRevision, 'prepared.toolRevision', 4_096),
        handlerRevision: requiredText(record.handlerRevision, 'prepared.handlerRevision', 4_096),
      };
    }
    const reason = record.reason === undefined
      ? undefined
      : requiredText(record.reason, 'prepared.reason', 2_048);
    if (kind === 'not_found' || kind === 'denied' || kind === 'active_capability') {
      return { name, kind, ...(reason === undefined ? {} : { reason }) };
    }
    const target = capabilityTarget(record.target);
    const availability = capabilityStatus(record.availability);
    const probeChoiceRef = record.probeChoiceRef === undefined
      ? undefined
      : requiredText(record.probeChoiceRef, 'prepared.probeChoiceRef', MAX_PROBE_REF_CHARS);
    if (record.bindingRequired !== undefined && record.bindingRequired !== true) {
      throw expectedToolError('precondition', 'Prepared Capability binding requirement is invalid.');
    }
    return {
      name,
      kind,
      target,
      availability,
      ...(reason === undefined ? {} : { reason }),
      ...(probeChoiceRef === undefined ? {} : { probeChoiceRef }),
      ...(record.bindingRequired === true ? { bindingRequired: true } : {}),
    };
  });
}

function capabilityTarget(value: PortableValue | undefined): RuntimeCapabilityDiscoveryTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw expectedToolError('precondition', 'Prepared Capability target is invalid.');
  }
  const record = value as Record<string, PortableValue>;
  if (Object.keys(record).some((key) => key !== 'moduleId' && key !== 'instanceId')) {
    throw expectedToolError('precondition', 'Prepared Capability target is invalid.');
  }
  return {
    moduleId: requiredText(record.moduleId, 'prepared.target.moduleId', 4_096),
    instanceId: requiredText(record.instanceId, 'prepared.target.instanceId', 4_096),
  };
}

function capabilityStatus(
  value: PortableValue | undefined,
): AgentCapabilityDiscoveryManifestEntry['status'] {
  if (
    value !== 'unloaded' && value !== 'available' && value !== 'unavailable' &&
    value !== 'degraded' && value !== 'disabled'
  ) {
    throw expectedToolError('precondition', 'Prepared Capability availability is invalid.');
  }
  return value;
}

function capabilitySearchDescriptor(
  capability: AgentCapabilityDiscoveryManifestEntry,
): AgentToolDescriptor {
  return {
    id: { name: capability.name }, flatName: capability.name,
    title: capability.name, description: capability.description,
    aliases: [], tags: ['capability'], inputSchema: { type: 'object' },
    outputSchema: { type: 'object' }, dangerLevel: 'medium', readonly: false,
    source: 'capability-manifest', exposure: 'deferred', access: 'external',
    recoveryClass: 'idempotent', limits: LIMITS,
    toolRevision: 'capability-manifest.v1', handlerRevision: 'capability-manifest.handler.v1',
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    execution: { concurrency: 'exclusive', timeoutMs: LIMITS.timeoutMs },
    failurePolicy: { onUnknown: { failureKind: 'tool_unavailable', retryable: true } },
  };
}

function uniqueTargets(
  targets: readonly RuntimeCapabilityDiscoveryTarget[],
): RuntimeCapabilityDiscoveryTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.moduleId}\0${target.instanceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((target) => ({ ...target }));
}

function capabilityTargetKey(target: RuntimeCapabilityDiscoveryTarget): string {
  return `${target.moduleId}\0${target.instanceId}`;
}

function uniqueToolActivations(
  activations: readonly RuntimeToolActivation[],
): RuntimeToolActivation[] {
  const byName = new Map<string, RuntimeToolActivation>();
  for (const activation of activations) {
    const previous = byName.get(activation.name);
    if (
      previous !== undefined &&
      (previous.toolRevision !== activation.toolRevision ||
        previous.handlerRevision !== activation.handlerRevision)
    ) {
      throw expectedToolError('conflict', `Tool generation changed within selection: ${activation.name}.`);
    }
    byName.set(activation.name, { ...activation });
  }
  return [...byName.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name));
}

function uniqueCapabilityBindings(
  bindings: readonly RuntimeCapabilityActivationBinding[],
): RuntimeCapabilityActivationBinding[] {
  const byTarget = new Map<string, RuntimeCapabilityActivationBinding>();
  for (const entry of bindings) {
    const key = `${entry.target.moduleId}\0${entry.target.instanceId}`;
    if (byTarget.has(key)) {
      throw expectedToolError('conflict', 'Capability activation returned duplicate bindings.');
    }
    byTarget.set(key, structuredClone(entry));
  }
  return [...byTarget.values()];
}

function requiredText(value: PortableValue | undefined, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw expectedToolError('invalid_argument', `${label} must be 1-${max} characters.`);
  }
  return value.trim();
}

function boundedInteger(value: PortableValue | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw expectedToolError('invalid_argument', `Integer input must be between ${min} and ${max}.`);
  }
  return candidate;
}

function boundedRevision(value: string): string {
  const revision = value.trim();
  if (!revision || revision.length > 128) throw new TypeError('Capability activator revision is invalid.');
  return revision;
}

function boundedReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = [...value].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 2_048) : undefined;
}

function activationResult(value: unknown): ToolSearchCapabilityActivationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capability activation returned an invalid result.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'status' && key !== 'reason' && key !== 'binding') ||
    (record.status !== 'activated' && record.status !== 'unavailable' && record.status !== 'denied') ||
    (record.reason !== undefined && typeof record.reason !== 'string') ||
    (record.binding !== undefined && record.status !== 'activated')
  ) {
    throw new Error('Capability activation returned an invalid result.');
  }
  const binding = record.binding === undefined
    ? undefined
    : capabilityActivationBinding(record.binding);
  return {
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(binding === undefined ? {} : { binding }),
  };
}

function capabilityActivationBinding(value: unknown): AgentCapabilityActivationBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capability activation binding is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = ['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('Capability activation binding is invalid.');
  }
  const portable = record as Record<string, PortableValue>;
  return Object.freeze({
    providerId: requiredText(portable.providerId, 'binding.providerId', 256),
    candidateId: requiredText(portable.candidateId, 'binding.candidateId', 256),
    fingerprint: requiredText(portable.fingerprint, 'binding.fingerprint', 512),
    capabilityGeneration: requiredText(
      portable.capabilityGeneration,
      'binding.capabilityGeneration',
      512,
    ),
  });
}

function digestRevision(value: string): string {
  // A small deterministic non-secret digest keeps handlerRevision bounded.
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertActive(context: ToolExecuteContext): void {
  if (context.signal.aborted || Date.now() >= Date.parse(context.deadline)) {
    throw new Error('Tool discovery activation was cancelled or expired.');
  }
}
