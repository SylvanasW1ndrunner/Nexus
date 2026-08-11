import { createHash } from 'node:crypto';
import { assertNoSecretMaterial, assertPortableValue, type PortableValue } from '@dbagent/shared';
import {
  RuntimeCommandError,
  type RuntimeCommand,
  type RuntimeCommandInput,
} from '../kernel/runtime-command.js';

const commandDigests = new WeakMap<object, string>();
const KINDS = new Set<RuntimeCommand['kind']>([
  'plan.create', 'plan.update', 'tool.activate', 'skill.activate',
  'child.start', 'child.steer', 'child.cancel',
]);

export type RuntimeCommandIssuer = Readonly<{
  issue(input: RuntimeCommandInput): RuntimeCommand;
}>;

export function createRuntimeCommandIssuer(): RuntimeCommandIssuer {
  return Object.freeze({
    issue(input: RuntimeCommandInput): RuntimeCommand {
      let clone: RuntimeCommand;
      try {
        clone = structuredClone(input);
        const candidate: unknown = clone;
        assertPortableValue(candidate);
        assertNoSecretMaterial(candidate);
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
  if (
    value === null || typeof value !== 'object' ||
    commandDigests.get(value) !== digest(value as RuntimeCommand)
  ) {
    throw new RuntimeCommandError(
      'RUNTIME_COMMAND_UNAUTHENTIC',
      'Runtime Command was not issued by the package-internal command authority.',
    );
  }
}

export function isAuthenticRuntimeCommand(value: unknown): value is RuntimeCommand {
  try {
    assertAuthenticRuntimeCommand(value);
    return true;
  } catch {
    return false;
  }
}

function validateRuntimeCommand(command: RuntimeCommand): void {
  exactKeys(command, [
    'schemaVersion', 'kind', 'commandId', 'origin', 'expectedRunRevision',
    'fencingToken', 'payload',
  ]);
  if (command.schemaVersion !== 1 || !KINDS.has(command.kind)) invalid('Unsupported kind/version.');
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
    case 'tool.activate':
      exactKeys(command.payload, ['names']);
      boundedTexts(command.payload.names, 'names', 256);
      break;
    case 'skill.activate':
      exactKeys(command.payload, ['ids']);
      boundedTexts(command.payload.ids, 'ids', 256);
      break;
    case 'child.start':
      exactKeys(command.payload, ['task', 'context']);
      text(command.payload.task, 'task');
      break;
    case 'child.steer':
      exactKeys(command.payload, ['childRunId', 'input']);
      text(command.payload.childRunId, 'childRunId');
      break;
    case 'child.cancel':
      exactKeys(command.payload, ['childRunId', 'reason'], ['reason']);
      text(command.payload.childRunId, 'childRunId');
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
  return createHash('sha256').update(canonicalJson(value as unknown as PortableValue)).digest('hex');
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
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
