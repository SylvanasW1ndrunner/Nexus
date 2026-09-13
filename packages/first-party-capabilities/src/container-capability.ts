import type { AgentCapabilityModuleRegistration } from '@dbagent/core-agent';
import { createCommandCapabilityRegistration } from './command-module.js';
import type { FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

const daemonRead = Object.freeze({ access: 'external' as const, recoveryClass: 'read' as const, dangerLevel: 'high' as const, actions: Object.freeze(['read', 'network', 'admin', 'unknown'] as const), network: true, externalWrite: false, destructive: false, admin: true, unknownRisk: true });
const daemonExecute = Object.freeze({ access: 'external' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, actions: Object.freeze(['write', 'execute', 'network', 'admin', 'unknown'] as const), network: true, externalWrite: true, destructive: false, admin: true, unknownRisk: true });
const daemonTarget = Object.freeze(['container-daemon']);
const empty = { type: 'object', additionalProperties: false } as const;
const containerInput = { type: 'object', additionalProperties: false, required: ['container'], properties: { container: { type: 'string', minLength: 1, maxLength: 128 } } } as const;
const logsInput = { type: 'object', additionalProperties: false, required: ['container'], properties: { container: { type: 'string', minLength: 1, maxLength: 128 }, tail: { type: 'integer', minimum: 1, maximum: 5000 } } } as const;
const execInput = { type: 'object', additionalProperties: false, required: ['container', 'command'], properties: { container: { type: 'string', minLength: 1, maxLength: 128 }, command: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 1024 } } } } as const;
const composeInput = { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['up', 'down'] }, file: { type: 'string', minLength: 1, maxLength: 8192 }, services: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } } } } as const;

/** Container commands use an already configured local docker or podman client; probe never contacts its daemon. */
export function createContainerCapability(host: FirstPartyCapabilityHost): AgentCapabilityModuleRegistration {
  return createCommandCapabilityRegistration({ moduleId: 'schemanaut.containers', capabilityId: 'schemanaut.containers', instanceId: 'first-party-containers', version: '1.0.0', description: 'Local container daemon operations using an externally configured docker or podman CLI.', executables: ['docker', 'podman'], selection: 'choice_required', operations: [
    { name: 'container_list', description: 'List containers through the selected local container daemon.', inputSchema: empty, argv: () => ['ps', '--all', '--format', 'json'], hostTargets: daemonTarget, permission: daemonRead, output: 'stable-text' },
    { name: 'container_inspect', description: 'Inspect one named container through the selected local container daemon.', inputSchema: containerInput, argv: input => ['inspect', container(input.container)], hostTargets: daemonTarget, permission: daemonRead, output: 'json' },
    { name: 'container_logs', description: 'Read bounded logs for one named container through the selected local container daemon.', inputSchema: logsInput, argv: input => ['logs', '--tail', String(integer(input.tail, 200, 1, 5000)), container(input.container)], hostTargets: daemonTarget, permission: daemonRead, output: 'stable-text' },
    { name: 'container_exec', description: 'Execute an explicit argv command in one named container via the local daemon.', inputSchema: execInput, argv: input => ['exec', container(input.container), ...command(input.command)], hostTargets: daemonTarget, permission: daemonExecute, output: 'stable-text' },
    { name: 'container_compose', description: 'Run an explicit non-idempotent Compose action through the local container daemon.', inputSchema: composeInput, argv: input => compose(input), pathInputs: input => optionalPath(input.file), hostTargets: daemonTarget, permission: daemonExecute, output: 'stable-text' },
  ] }, host);
}

function container(value: unknown): string { const result = text(value, 'container', 128); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(result)) throw new TypeError('container is invalid.'); return result; }
function command(value: unknown): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new TypeError('command is invalid.'); return value.map(item => text(item, 'command argument', 1024)); }
function compose(input: Readonly<Record<string, unknown>>): readonly string[] { const action = input.action; if (action !== 'up' && action !== 'down') throw new TypeError('compose action is invalid.'); const file = input.file === undefined ? [] : ['--file', text(input.file, 'file', 8192)]; const services = input.services === undefined ? [] : serviceNames(input.services); if (action === 'down' && services.length) throw new TypeError('compose down does not accept services.'); return ['compose', ...file, action, ...(action === 'up' ? ['--detach', ...services] : [])]; }
function serviceNames(value: unknown): readonly string[] { if (!Array.isArray(value) || value.length > 32) throw new TypeError('services are invalid.'); return value.map(item => { const result = text(item, 'service', 128); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(result)) throw new TypeError('service is invalid.'); return result; }); }
function optionalPath(value: unknown): readonly string[] { return value === undefined ? [] : [text(value, 'file', 8192)]; }
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('integer input is invalid.'); return value; }
function text(value: unknown, name: string, maximum: number): string { if (typeof value !== 'string' || !value.trim() || value.length > maximum || hasControlCodePoint(value)) throw new TypeError(`${name} is invalid.`); return value; }
