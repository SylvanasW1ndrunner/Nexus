import type { AgentCapabilityModuleRegistration } from '@dbagent/core-agent';
import { createCommandCapabilityRegistration } from './command-module.js';
import type { FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

const read = Object.freeze({ access: 'read' as const, recoveryClass: 'read' as const, dangerLevel: 'safe' as const, actions: Object.freeze(['read'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: false });
const cargoCheck = Object.freeze({ access: 'read' as const, recoveryClass: 'read' as const, dangerLevel: 'high' as const, actions: Object.freeze(['read', 'execute', 'unknown'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: true });
const format = Object.freeze({ access: 'write' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, actions: Object.freeze(['write'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: true });
const empty = { type: 'object', additionalProperties: false } as const;
const formatInput = { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;

/** Language tools select one already-installed backend; v1 does not own an LSP process or project configuration. */
export function createLanguageCapability(host: FirstPartyCapabilityHost): AgentCapabilityModuleRegistration {
  return createCommandCapabilityRegistration({ moduleId: 'schemanaut.language', capabilityId: 'schemanaut.language', instanceId: 'first-party-language', version: '1.0.0', description: 'Language diagnostics, symbols, and formatting from externally installed project CLIs.', executables: ['tsc', 'pyright', 'ruff', 'cargo', 'go', 'ctags', 'gofmt'], selection: 'choice_required', degradeWhenPartialAvailability: true, operations: [
    { name: 'language_diagnostics', description: 'Read TypeScript diagnostics from the selected tsc backend.', inputSchema: empty, providers: ['tsc'], argv: () => ['--noEmit', '--pretty', 'false'], permission: read, output: 'stable-text' },
    { name: 'language_diagnostics', description: 'Read Python diagnostics from the selected pyright backend.', inputSchema: empty, providers: ['pyright'], argv: () => ['--outputjson'], permission: read, output: 'json' },
    { name: 'language_diagnostics', description: 'Read Python lint diagnostics from the selected ruff backend.', inputSchema: empty, providers: ['ruff'], argv: () => ['check', '--output-format', 'json', '.'], permission: read, output: 'json' },
    { name: 'language_diagnostics', description: 'Read Rust diagnostics from cargo check; build scripts may execute.', inputSchema: empty, providers: ['cargo'], argv: () => ['check', '--message-format=json'], permission: cargoCheck, output: 'stable-text' },
    { name: 'language_diagnostics', description: 'Read Go diagnostics from the selected go backend.', inputSchema: empty, providers: ['go'], argv: () => ['vet', './...'], permission: read, output: 'stable-text' },
    { name: 'language_symbols', description: 'Read workspace symbols from the selected ctags backend.', inputSchema: empty, providers: ['ctags'], argv: () => ['--output-format=json', '--fields=+n', '--sort=no', '-R', '.'], permission: read, output: 'stable-text' },
    { name: 'language_format', description: 'Format one explicit workspace path with the selected ruff backend.', inputSchema: formatInput, providers: ['ruff'], argv: input => ['format', requiredPath(input.path)], pathInputs: input => [requiredPath(input.path)], permission: format, output: 'stable-text' },
    { name: 'language_format', description: 'Format one explicit workspace path with the selected gofmt backend.', inputSchema: formatInput, providers: ['gofmt'], argv: input => ['-w', requiredPath(input.path)], pathInputs: input => [requiredPath(input.path)], permission: format, output: 'stable-text' },
  ] }, host);
}

function requiredPath(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || hasControlCodePoint(value)) throw new TypeError('path is invalid.'); return value; }
