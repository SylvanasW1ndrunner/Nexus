import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createAgentSession,
  isAgentToolResultEnvelope,
} from '@dbagent/core-agent';
import { ProcessRuntime, registerProcessTools } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('process tools', () => {
  it('registers discoverable tools with permission, concurrency, and completion contracts', async () => {
    const fixture = await toolsFixture();

    expect(fixture.registry.get('process_exec')?.descriptor).toMatchObject({
      exposure: 'deferred',
      requiredPermission: 'full',
      execution: { concurrency: 'exclusive' },
      completion: { role: 'deliverable', group: 'process-execution' },
    });
    const pollDescriptor = fixture.registry.get('process_poll')?.descriptor;
    expect(pollDescriptor).toMatchObject({
      execution: { concurrency: 'read' },
      completion: { role: 'deliverable', group: 'process-execution' },
    });
    expect(pollDescriptor?.aliases).toEqual(
      expect.arrayContaining(['command completion', '命令运行状态', '命令是否完成']),
    );
  });

  it('executes commands through result envelopes without persisting full output', async () => {
    const fixture = await toolsFixture({ maxProjectionBytes: 96 });
    const session = createAgentSession({
      id: 'process-session',
      title: 'Process',
      mode: 'full',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    const command = nodeCommand(`process.stdout.write('A'.repeat(500));`);

    const value = await fixture.registry.get('process_exec')!.handler(
      { command, timeoutMs: 5_000 },
      { session },
    );

    expect(isAgentToolResultEnvelope(value)).toBe(true);
    if (!isAgentToolResultEnvelope(value)) throw new Error('Expected tool result envelope.');
    expect(value.modelProjection).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(JSON.stringify(value.modelProjection).length).toBeLessThan(1_000);
    expect(value.durableSummary).toMatchObject({
      status: 'exited',
      exitCode: 0,
      outputStoredSeparately: true,
    });
    expect(JSON.stringify(value.durableSummary)).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    expect(value.completionEvidence).toMatchObject({
      kind: 'process',
      deliveryReady: true,
      source: 'runtime',
    });
  });

  it('starts, polls, writes, and terminates a session-owned background process', async () => {
    const fixture = await toolsFixture();
    const session = createAgentSession({
      id: 'process-session',
      title: 'Process',
      mode: 'full',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    const command = nodeCommand(
      "process.stdin.resume(); process.stdout.write('ready'); setTimeout(() => {}, 10000);",
    );

    const startedValue = await fixture.registry.get('process_exec')!.handler(
      { command, background: true, timeoutMs: 20_000 },
      { session },
    );
    if (!isAgentToolResultEnvelope(startedValue)) throw new Error('Expected result envelope.');
    const processId = (startedValue.modelProjection as { processId: string }).processId;

    const polledValue = await fixture.registry.get('process_poll')!.handler(
      { processId, waitMs: 100 },
      { session },
    );
    expect(isAgentToolResultEnvelope(polledValue)).toBe(true);
    await fixture.registry.get('process_write')!.handler(
      { processId, input: 'hello' },
      { session },
    );
    const terminatedValue = await fixture.registry.get('process_terminate')!.handler(
      { processId },
      { session },
    );
    if (!isAgentToolResultEnvelope(terminatedValue)) throw new Error('Expected result envelope.');
    expect(terminatedValue.modelProjection).toMatchObject({ status: 'terminated' });
  });
});

async function toolsFixture(options: { maxProjectionBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'schemanaut-process-tools-'));
  const runtime = new ProcessRuntime({
    spoolDirectory: join(root, '.spool'),
    maxProjectionBytes: options.maxProjectionBytes ?? 4_096,
  });
  const registry = new ToolRegistry();
  registerProcessTools(registry, { rootPath: root, runtime });
  cleanups.push(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, registry };
}

function nodeCommand(source: string): string {
  return [process.execPath, '-e', source]
    .map((value) => `"${value.replaceAll('"', '\\"')}"`)
    .join(' ');
}
