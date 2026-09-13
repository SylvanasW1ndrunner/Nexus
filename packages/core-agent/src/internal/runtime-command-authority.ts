import { createHash } from 'node:crypto';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import {
  RuntimeCommandError,
  type RuntimeCommand,
  type RuntimeCommandApplicationResult,
  type RuntimeCommandInput,
} from '../kernel/runtime-command.js';
import type { AgentJournal } from '../events/agent-journal.js';

const commandDigests = new WeakMap<object, string>();
const applicationCommitters = new WeakMap<
  object,
  (command: RuntimeCommand) => Promise<RuntimeCommandApplicationResult>
>();
const KINDS = new Set<RuntimeCommand['kind']>([
  'plan.create', 'plan.update', 'discovery.activate', 'skill.activate',
  'child.start', 'child.list', 'child.wait', 'child.steer', 'child.cancel',
]);

export type RuntimeCommandIssuer = Readonly<{
  issue(input: RuntimeCommandInput): RuntimeCommand;
}>;

export type RuntimeCommandApplication = Readonly<{
  apply(command: RuntimeCommand): Promise<RuntimeCommandApplicationResult>;
}>;

export function createRuntimeCommandIssuer(): RuntimeCommandIssuer {
  return Object.freeze({
    issue(input: RuntimeCommandInput): RuntimeCommand {
      let clone: RuntimeCommand;
      try {
        clone = structuredClone(input);
        const candidate: unknown = clone;
        assertPortableValue(candidate);
      } catch (error) {
        throw new RuntimeCommandError(
          'RUNTIME_COMMAND_INVALID', `Runtime Command is not portable: ${message(error)}`,
        );
      }
      validateRuntimeCommand(clone);
      const frozen = deepFreeze(clone);
      commandDigests.set(frozen, digest(frozen));
      return frozen;
    },
  });
}

export function assertAuthenticRuntimeCommand(value: unknown): asserts value is RuntimeCommand {
  if (value === null || typeof value !== 'object') {
    unauthentic();
  }
  const expectedDigest = commandDigests.get(value);
  if (expectedDigest === undefined) {
    unauthentic();
  }
  if (expectedDigest !== digest(value as RuntimeCommand)) {
    unauthentic();
  }
}

function unauthentic(): never {
    throw new RuntimeCommandError(
      'RUNTIME_COMMAND_UNAUTHENTIC',
      'Runtime Command was not issued by the package-internal command authority.',
    );
}

export function isAuthenticRuntimeCommand(value: unknown): value is RuntimeCommand {
  try {
    assertAuthenticRuntimeCommand(value);
    return true;
  } catch {
    return false;
  }
}

/** Package-internal composition hook. Only a Journal implementation can own the commit. */
export function bindRuntimeCommandApplication(
  journal: AgentJournal,
  committer: (command: RuntimeCommand) => Promise<RuntimeCommandApplicationResult>,
): void {
  if (applicationCommitters.has(journal)) {
    throw new Error('Runtime Command application is already bound for this Journal.');
  }
  applicationCommitters.set(journal, committer);
}

/**
 * Opens the sealed application capability. Admission is checked before any
 * command property is read, cloned or handed to durable storage.
 */
export function openRuntimeCommandApplication(
  journal: AgentJournal,
): RuntimeCommandApplication {
  const committer = applicationCommitters.get(journal);
  if (committer === undefined) {
    throw new Error('Journal has no Runtime Command application authority.');
  }
  return Object.freeze({
    async apply(command: RuntimeCommand): Promise<RuntimeCommandApplicationResult> {
      assertAuthenticRuntimeCommand(command);
      return await committer(command);
    },
  });
}

function validateRuntimeCommand(command: RuntimeCommand): void {
  exactKeys(command, [
    'schemaVersion', 'kind', 'commandId', 'origin', 'expectedRunRevision',
    'fencingToken', 'payload',
  ]);
  if (command.schemaVersion !== 2 || !KINDS.has(command.kind)) invalid('Unsupported kind/version.');
  text(command.commandId, 'commandId');
  exactKeys(command.origin, ['runId', 'turnId', 'invocationId']);
  text(command.origin.runId, 'origin.runId');
  text(command.origin.turnId, 'origin.turnId');
  text(command.origin.invocationId, 'origin.invocationId');
  positive(command.expectedRunRevision, 'expectedRunRevision');
  positive(command.fencingToken, 'fencingToken');
  switch (command.kind) {
    case 'plan.create':
      exactKeys(command.payload, ['planId', 'plan']);
      text(command.payload.planId, 'planId');
      break;
    case 'plan.update':
      exactKeys(command.payload, ['planId', 'expectedPlanRevision', 'plan']);
      text(command.payload.planId, 'planId');
      positive(command.payload.expectedPlanRevision, 'expectedPlanRevision');
      break;
    case 'discovery.activate':
      exactKeys(command.payload, ['tools', 'targets', 'bindings']);
      boundedToolActivations(command.payload.tools);
      boundedCapabilityTargets(command.payload.targets);
      boundedCapabilityBindings(command.payload.bindings, command.payload.targets);
      if (command.payload.tools.length === 0 && command.payload.targets.length === 0) {
        invalid('Discovery activation must contain at least one Tool or Capability.');
      }
      break;
    case 'skill.activate':
      exactKeys(command.payload, ['activations']);
      boundedSkillActivations(command.payload.activations);
      break;
    case 'child.start':
      exactKeys(command.payload, ['task', 'context']);
      text(command.payload.task, 'task');
      break;
    case 'child.list':
      exactKeys(command.payload, []);
      break;
    case 'child.wait':
      exactKeys(command.payload, ['childRunId', 'expectedChildRevision']);
      text(command.payload.childRunId, 'childRunId');
      positive(command.payload.expectedChildRevision, 'expectedChildRevision');
      break;
    case 'child.steer':
      exactKeys(command.payload, ['childRunId', 'expectedChildRevision', 'input']);
      text(command.payload.childRunId, 'childRunId');
      positive(command.payload.expectedChildRevision, 'expectedChildRevision');
      break;
    case 'child.cancel':
      exactKeys(
        command.payload,
        ['childRunId', 'expectedChildRevision', 'reason'],
        ['reason'],
      );
      text(command.payload.childRunId, 'childRunId');
      positive(command.payload.expectedChildRevision, 'expectedChildRevision');
      if (command.payload.reason !== undefined) text(command.payload.reason, 'reason');
      break;
    default:
      assertNever(command);
  }
  if (Buffer.byteLength(JSON.stringify(command), 'utf8') > 256 * 1024) {
    invalid('Runtime Command exceeds the bounded payload limit.');
  }
}

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.includes(key))
  ) invalid(`Unexpected or missing keys: ${actual.join(',')}.`);
}

function boundedTexts(value: unknown, name: string, max: number): void {
  if (!Array.isArray(value) || value.length > max) invalid(`${name} is unbounded.`);
  value.forEach((item) => text(item, name));
}

function boundedToolActivations(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid('Tool activations are unbounded.');
  const names = new Set<string>();
  for (const activation of value) {
    if (activation === null || typeof activation !== 'object' || Array.isArray(activation)) {
      invalid('Tool activations must be exact revision identities.');
    }
    const record = activation as Record<string, unknown>;
    exactKeys(record, ['name', 'toolRevision', 'handlerRevision']);
    text(record.name, 'tools.name');
    text(record.toolRevision, 'tools.toolRevision');
    text(record.handlerRevision, 'tools.handlerRevision');
    if (names.has(record.name)) invalid('Tool activations contain duplicate names.');
    names.add(record.name);
  }
}

function boundedCapabilityTargets(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) {
    invalid('Capability discovery targets are unbounded.');
  }
  const identities = new Set<string>();
  for (const target of value) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      invalid('targets must be module instance identities.');
    }
    const targetRecord = target as Record<string, unknown>;
    exactKeys(targetRecord, ['moduleId', 'instanceId']);
    text(targetRecord.moduleId, 'targets.moduleId');
    text(targetRecord.instanceId, 'targets.instanceId');
    const identity = `${targetRecord.moduleId}\0${targetRecord.instanceId}`;
    if (identities.has(identity)) invalid('targets contains duplicate module instances.');
    identities.add(identity);
  }
}

function boundedCapabilityBindings(value: unknown, allowedTargets: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid('Capability activation bindings are unbounded.');
  if (!Array.isArray(allowedTargets)) invalid('Capability activation targets are invalid.');
  const allowed = new Set(allowedTargets.map((target) => {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) invalid('Capability target is invalid.');
    const record = target as Record<string, unknown>;
    return `${String(record.moduleId)}\0${String(record.instanceId)}`;
  }));
  const targets = new Set<string>();
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalid('Capability activation binding entry must be an object.');
    }
    const entry = candidate as Record<string, unknown>;
    exactKeys(entry, ['target', 'binding']);
    boundedCapabilityTargets([entry.target]);
    if (entry.target === null || typeof entry.target !== 'object' || Array.isArray(entry.target)) invalid('Binding target is invalid.');
    const target = entry.target as Record<string, unknown>;
    const identity = `${String(target.moduleId)}\0${String(target.instanceId)}`;
    if (!allowed.has(identity)) invalid('Capability activation binding target was not selected.');
    if (targets.has(identity)) invalid('Capability activation bindings repeat a target.');
    targets.add(identity);
    if (entry.binding === null || typeof entry.binding !== 'object' || Array.isArray(entry.binding)) invalid('Binding is invalid.');
    const binding = entry.binding as Record<string, unknown>;
    exactKeys(binding, ['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration']);
    for (const key of ['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration']) {
      text(binding[key], `bindings.${key}`);
    }
  }
}

function boundedSkillActivations(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid('activations is unbounded.');
  const ids = new Set<string>();
  for (const activation of value) {
    if (activation === null || typeof activation !== 'object' || Array.isArray(activation)) {
      invalid('activations must be Skill revision identities.');
    }
    const activationRecord = activation as Record<string, unknown>;
    exactKeys(activationRecord, ['id', 'revision'], ['allowedTools']);
    text(activationRecord.id, 'activations.id');
    const activationId = activationRecord.id;
    if (ids.has(activationId)) invalid('activations contains duplicate Skill identities.');
    ids.add(activationId);
    if (activationRecord.revision === null || typeof activationRecord.revision !== 'object' || Array.isArray(activationRecord.revision)) {
      invalid('activations.revision must be a Skill revision identity.');
    }
    const revision = activationRecord.revision as Record<string, unknown>;
    exactKeys(revision, [
      'schemaVersion', 'revisionId', 'scope', 'sourceId', 'sourcePath', 'bundleRoot',
      'sourceOrder', 'name', 'contentDigest', 'bundleDigest',
    ]);
    if (revision.schemaVersion !== 1) invalid('Skill revision schemaVersion is unsupported.');
    for (const key of ['revisionId', 'sourceId', 'sourcePath', 'bundleRoot', 'name', 'contentDigest', 'bundleDigest']) {
      text(revision[key], `activations.revision.${key}`);
    }
    if (!['system', 'user', 'project', 'session'].includes(revision.scope as string)) {
      invalid('Skill revision scope is invalid.');
    }
    if (!Number.isInteger(revision.sourceOrder) || (revision.sourceOrder as number) < 0) {
      invalid('Skill revision sourceOrder is invalid.');
    }
    if (activationRecord.allowedTools !== undefined) boundedTexts(activationRecord.allowedTools, 'activations.allowedTools', 256);
  }
}

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4_096) {
    invalid(`${name} must be bounded text.`);
  }
}

function positive(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${name} must be positive.`);
}

function invalid(messageText: string): never {
  throw new RuntimeCommandError('RUNTIME_COMMAND_INVALID', messageText);
}

function assertNever(value: never): never {
  return invalid(`Unsupported Runtime Command ${String(value)}.`);
}

function digest(value: RuntimeCommand): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key] as PortableValue)}`).join(',')}}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
