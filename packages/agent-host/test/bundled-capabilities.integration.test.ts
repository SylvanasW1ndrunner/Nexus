import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPrepareContext } from '@dbagent/core-agent';
import { AgentRuntime } from '../src/agent-runtime.js';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('bundled first-party capabilities', () => {
  it('registers eight static manifests with zero activation side effects, then activates native data tools on demand', async () => {
    const fixture = await workspace();
    const runtime = createBundledAgentRuntime({ projectDirectory: fixture.root, globalConfigStore: new GlobalConfigStore({ path: fixture.config }) });
    try {
      const initial = runtime.status().capabilities.modules;
      expect(initial.map(module => module.moduleId)).toEqual(expect.arrayContaining([
        'schemanaut.git', 'schemanaut.database', 'schemanaut.forge', 'schemanaut.containers',
        'schemanaut.browser', 'schemanaut.language', 'schemanaut.documents', 'schemanaut.data-notebook',
      ]));
      expect(initial).toHaveLength(8);
      expect(initial.every(module => module.active === false && module.status === 'unloaded')).toBe(true);
      expect(runtime.listAgentTools().map(tool => tool.name)).not.toContain('data_profile');
      await runtime.ready();
      await runtime.activateModule('schemanaut.data-notebook', 'first-party-data-notebook');
      expect(runtime.listAgentTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['data_profile', 'notebook_inspect']));
    } finally { await runtime.close(); }
  });

  it('keeps the bare AgentRuntime free of default professional capabilities', async () => {
    const fixture = await workspace();
    const runtime = new AgentRuntime({ projectDirectory: fixture.root, globalConfigStore: new GlobalConfigStore({ path: fixture.config }) });
    try { expect(runtime.status().capabilities.modules).toEqual([]); }
    finally { await runtime.close(); }
  });

  it('applies global require_sandbox to the Host-owned command runtime', async () => {
    const fixture = await workspace();
    await writeFile(fixture.config, 'version = 1\n\n[agent]\npermission_mode = "full-access"\nrequire_sandbox = true\n', 'utf8');
    const runtime = createBundledAgentRuntime({ projectDirectory: fixture.root, globalConfigStore: new GlobalConfigStore({ path: fixture.config }) });
    try {
      await runtime.ready();
      expect(await runtime.getGlobalConfig()).toMatchObject({ permissionMode: 'full-access', requireSandbox: true });
      const services = requireAgentRuntimeHostServices(runtime);
      const executable = await services.executables.discover('node');
      expect(executable.status).toBe('available');
      if (executable.status !== 'available') return;
      const limits = { timeoutMs: 30_000, maxInputBytes: 32_768, maxOutputBytes: 32_768, maxArtifactBytes: 32_768, maxDepth: 8, maxRecords: 128 };
      const context = {
        hostId: 'local', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key', runtimeState: {} as never, discoverableTools: [], discoverableCapabilities: [], signal: new AbortController().signal,
        runPolicy: { mode: 'full-access', revision: 'run-policy.v1' }, generation: 'test-generation@1', descriptor: { flatName: 'fixture_command' }, toolRevision: 'fixture_command@1', handlerRevision: 'fixture-handler@1', intentRevision: 'prepared-tool-intent.v1', limits,
      } as unknown as ToolPrepareContext;
      const intent = await services.command.prepare({ executable: executable.launch, argv: ['--version'], cwd: fixture.root, pathTargets: [], hostTargets: [], requested: { network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false }, permission: { access: 'read', recoveryClass: 'read', dangerLevel: 'safe', actions: ['read', 'execute'] }, resourceKeys: ['fixture:command'], limits }, context);
      expect((intent.input.plan as unknown as { boundary: { decision: string } }).boundary.decision).toBe('unavailable');
    } finally { await runtime.close(); }
  });
});

async function workspace(): Promise<{ root: string; config: string }> {
  const root = await mkdtemp(join(tmpdir(), 'schemanaut-bundled-capabilities-')); directories.push(root);
  return { root, config: join(root, 'global-config.toml') };
}
