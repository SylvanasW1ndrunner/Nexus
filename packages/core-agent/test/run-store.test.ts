import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentSessionStore,
  agentProjectReference,
  createAgentProjectContext,
  type AgentRunRecord,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Agent run store', () => {
  it('recovers interrupted runs and isolates them by Project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-agent-runs-'));
    directories.push(directory);
    const filePath = join(directory, 'state.db');
    const projectA = agentProjectReference(createAgentProjectContext(join(directory, 'a')));
    const projectB = agentProjectReference(createAgentProjectContext(join(directory, 'b')));
    const storeA = new AgentSessionStore(filePath).forProject(projectA);
    const storeB = new AgentSessionStore(filePath).forProject(projectB);
    await storeA.saveRun(record('run-a', 'running'));

    await expect(storeA.recoverInterrupted('2026-07-27T00:01:00.000Z')).resolves.toBe(1);
    const recovered = await storeA.getRun('run-a');
    expect(recovered).toMatchObject({
      status: 'interrupted',
      phase: 'verify',
    });
    expect(recovered?.errorMessage).toContain('terminal state');
    await expect(storeB.getRun('run-a')).resolves.toBeUndefined();
    await expect(storeB.saveRun(record('run-a', 'done'))).rejects.toThrow('another Project');
  });
});

function record(
  runId: string,
  status: AgentRunRecord['status'],
): AgentRunRecord {
  return {
    runId,
    sessionId: 'session-a',
    status,
    phase: status === 'done' ? 'done' : 'act',
    iteration: status === 'done' ? 2 : 1,
    finalText: status === 'done' ? 'Done.' : '',
    toolExecutions: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}
