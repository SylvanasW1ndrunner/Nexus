import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREPARED_TOOL_INTENT_REVISION,
  type AgentCapabilityModuleRegistration,
  type ToolInvocationContribution,
} from '@dbagent/core-agent';
import { AgentRuntime } from '../src/agent-runtime.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('AgentRunHandle capability fixture', () => {
  it('publishes a complete prepared Tool runtime through a normal module registration', async () => {
    const projectDirectory = await project();
    const runtime = new AgentRuntime({
      projectDirectory,
      stateDatabasePath: join(projectDirectory, '.schemanaut', 'state.db'),
      modules: [fixtureModule('fixture.prepared-tool')],
    });
    try {
      await runtime.activateModule('fixture.prepared-tool', 'primary');
      expect(runtime.listAgentTools()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'fixture_echo', exposure: 'deferred' }),
      ]));
    } finally {
      await runtime.close();
    }
  });
});

function fixtureModule(id: string): AgentCapabilityModuleRegistration {
  return {
    manifest: { id, version: '1', description: 'Prepared tool fixture', capabilities: [{ id: `${id}.echo`, description: 'Echo' }] },
    instanceId: 'primary',
    load: () => ({
      activate: () => ({ contributions: { tools: [preparedEchoTool()] } }),
    }),
  };
}

function preparedEchoTool(): ToolInvocationContribution {
  const toolRevision = 'fixture_echo@1';
  const handlerRevision = 'fixture_echo.handler@1';
  const limits = { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 };
  return {
    definition: {
      name: 'fixture_echo', description: 'Echoes a small test payload.',
      inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      dangerLevel: 'safe', readonly: true, source: 'fixture', exposure: 'deferred',
      access: 'read', recoveryClass: 'read', limits, toolRevision, handlerRevision,
      intentRevision: PREPARED_TOOL_INTENT_REVISION, execution: { concurrency: 'read', timeoutMs: limits.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    runtime: {
      revision: { toolName: 'fixture_echo', toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare: (input) => ({
        input, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
        targetIdentity: { kind: 'fixture' }, generation: 'fixture-generation@1', action: { summary: 'Echo fixture payload.' },
        permission: { toolName: 'fixture_echo', dangerLevel: 'safe', readonly: true, access: 'read', recoveryClass: 'read', actions: ['read'], paths: [], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [] },
        access: 'read', recoveryClass: 'read', concurrency: 'read', resourceKeys: ['fixture:echo'], limits,
      }),
      execute: (input) => ({ echoed: input }),
    },
  };
}

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-run-handle-'));
  directories.push(directory);
  return directory;
}
