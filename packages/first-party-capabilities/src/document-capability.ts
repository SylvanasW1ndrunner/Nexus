import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expectedToolError, type AgentCapabilityModule, type AgentCapabilityModuleRegistration, type AgentCapabilityModuleRuntime, type AgentCapabilityProbeResult, type ToolInvocationContribution, type ToolPrepareContext } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import { createCommandCapabilityRegistration } from './command-module.js';
import type { CommandCapabilityOperation, FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

const read = Object.freeze({ access: 'read' as const, recoveryClass: 'read' as const, dangerLevel: 'safe' as const, actions: Object.freeze(['read'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: false });
const convert = Object.freeze({ access: 'write' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, actions: Object.freeze(['write'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: true });
const input = { type: 'object', additionalProperties: false, required: ['input'], properties: { input: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;
const conversion = { type: 'object', additionalProperties: false, required: ['input', 'output'], properties: { input: { type: 'string', minLength: 1, maxLength: 8192 }, output: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;

/** Document tools use only user-installed CLIs and never install or configure them. */
export function createDocumentCapability(host: FirstPartyCapabilityHost): AgentCapabilityModuleRegistration {
  return Object.freeze({
    manifest: Object.freeze({ id: 'schemanaut.documents', version: '1.0.0', description: 'Metadata, extraction, and conversion through externally installed document CLIs.', capabilities: Object.freeze([{ id: 'schemanaut.documents', description: 'Document operations.' }]) }),
    instanceId: 'first-party-documents',
    load: () => Promise.resolve(module(host)),
  });
}

function module(host: FirstPartyCapabilityHost): AgentCapabilityModule {
  const discover = async () => Promise.all(['pdfinfo', 'pdftotext', 'pandoc'].map(async name => ({ name, result: await host.executables.discover(name) })));
  const probe = async (): Promise<AgentCapabilityProbeResult> => {
    const found = await discover(); const ready = found.filter(item => item.result.status === 'available').map(item => item.name);
    const status = ready.length === 3 ? 'available' as const : ready.length ? 'degraded' as const : 'unavailable' as const;
    const reason = status === 'available' ? undefined : ready.length ? `Available document commands: ${ready.join(', ')}. Install the remaining CLIs externally and restart the Host after changing PATH.` : 'Install pandoc, pdftotext, or pdfinfo externally and restart the Host after changing PATH.';
    return reason === undefined ? { status, capabilities: { 'schemanaut.documents': { status } } } : { status, reason, capabilities: { 'schemanaut.documents': { status, reason } } };
  };
  const activate = async (): Promise<AgentCapabilityModuleRuntime> => {
    const found = await discover(); const names = new Set(found.filter(item => item.result.status === 'available').map(item => item.name));
    const tools: ToolInvocationContribution[] = [];
    if (names.has('pdfinfo')) tools.push(await commandTool('document_metadata', 'pdfinfo', metadata(), host));
    if (names.has('pdftotext')) tools.push(await commandTool('document_extract', 'pdftotext', extract(), host));
    if (names.has('pandoc')) tools.push(await commandTool('document_convert', 'pandoc', convertOperation(), host));
    return Object.freeze({ contributions: Object.freeze({ tools: Object.freeze(tools) }), close: () => Promise.resolve(undefined) });
  };
  return Object.freeze({ probe, activate, refresh: () => activate(), dispose: () => Promise.resolve(undefined) });
}

async function commandTool(name: string, executable: string, operation: CommandCapabilityOperation, host: FirstPartyCapabilityHost): Promise<ToolInvocationContribution> {
  const registration = createCommandCapabilityRegistration({ moduleId: `schemanaut.documents.${name}`, capabilityId: 'schemanaut.documents', instanceId: `first-party-documents-${name}`, version: '1.0.0', description: operation.description, executables: [executable], operations: [operation] }, host);
  const tool = (await (await registration.load()).activate()).contributions.tools?.[0];
  if (!tool) throw expectedToolError('precondition', `External ${executable} CLI is unavailable.`);
  if (name !== 'document_convert') return tool;
  return Object.freeze({
    definition: tool.definition,
    runtime: Object.freeze({ ...tool.runtime, prepare: async (value: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext) => {
      const output = value.output;
      if (typeof output !== 'string') throw expectedToolError('invalid_argument', 'Document output path is required.');
      await assertAbsent(output, host.workspaceRoot);
      return tool.runtime.prepare(value, context);
    } }),
  });
}

function metadata(): CommandCapabilityOperation { return { name: 'document_metadata', description: 'Read metadata from an explicit PDF file.', inputSchema: input, argv: value => [required(value.input, 'input')], pathInputs: value => [required(value.input, 'input')], permission: read, output: 'stable-text' }; }
function extract(): CommandCapabilityOperation { return { name: 'document_extract', description: 'Extract text from an explicit PDF file.', inputSchema: input, argv: value => [required(value.input, 'input'), '-'], pathInputs: value => [required(value.input, 'input')], permission: read, output: 'stable-text' }; }
function convertOperation(): CommandCapabilityOperation { return { name: 'document_convert', description: 'Convert one explicit document input to one new explicit output path.', inputSchema: conversion, argv: value => [required(value.input, 'input'), '--output', required(value.output, 'output')], pathInputs: value => [required(value.input, 'input'), required(value.output, 'output')], permission: convert, output: 'stable-text' }; }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || hasControlCodePoint(value)) throw expectedToolError('invalid_argument', `${label} path is invalid.`); return value; }
async function assertAbsent(path: string, root: string): Promise<void> { try { await lstat(resolve(root, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } throw expectedToolError('precondition', 'Document output already exists; choose an explicit new path.'); }
