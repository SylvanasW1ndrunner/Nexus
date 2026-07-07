import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAuditLogStore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentAuditLogStore', () => {
  it('appends JSONL audit events and reads recent events in order', async () => {
    const store = new AgentAuditLogStore(await auditPath());

    await store.append({
      type: 'run_started',
      timestamp: '2026-07-07T01:00:00.000Z',
      sessionId: 'session_audit',
      mode: 'readonly',
      usageMode: 'byok',
      maxIterations: 3,
      allowedTools: ['query_database'],
    });
    await store.append({
      type: 'run_finished',
      timestamp: '2026-07-07T01:00:01.000Z',
      sessionId: 'session_audit',
      status: 'done',
      iterations: 1,
      durationMs: 12,
      finalTextPreview: '完成订单分析',
    });

    await expect(store.readAll()).resolves.toMatchObject([
      { type: 'run_started', sessionId: 'session_audit', allowedTools: ['query_database'] },
      { type: 'run_finished', status: 'done', finalTextPreview: '完成订单分析' },
    ]);
    await expect(store.readRecent(1)).resolves.toMatchObject([{ type: 'run_finished' }]);
  });

  it('redacts secrets and bounds large values before writing audit files', async () => {
    const filePath = await auditPath();
    const store = new AgentAuditLogStore(filePath);
    const apiKey = ['sk', 'audit-secret-123456'].join('-');
    const databaseUrl = 'postgresql://tester:localpass@127.0.0.1/app';

    await store.append({
      type: 'tool_call_finished',
      timestamp: '2026-07-07T01:00:00.000Z',
      sessionId: 'session_secret',
      iteration: 1,
      toolCallId: 'call_secret',
      toolName: 'query_database',
      status: 'failed',
      durationMs: 3,
      resultPreview: JSON.stringify({
        apiKey,
        databaseUrl,
        payload: 'x'.repeat(6_000),
      }),
    });

    const serialized = JSON.stringify(await store.readAll());

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('localpass');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[truncated]');
  });

  it('skips corrupt JSONL lines so diagnostics stay usable after partial writes', async () => {
    const filePath = await auditPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'run_started',
          timestamp: '2026-07-07T01:00:00.000Z',
          sessionId: 'session_ok',
          mode: 'readonly',
          usageMode: 'byok',
          maxIterations: 1,
        }),
        '{ broken json',
        JSON.stringify({
          type: 'run_finished',
          timestamp: '2026-07-07T01:00:01.000Z',
          sessionId: 'session_ok',
          status: 'done',
          iterations: 1,
          durationMs: 8,
        }),
      ].join('\n'),
      'utf8',
    );
    const store = new AgentAuditLogStore(filePath);

    await expect(store.readAll()).resolves.toMatchObject([
      { type: 'run_started', sessionId: 'session_ok' },
      { type: 'run_finished', status: 'done' },
    ]);
  });
});

async function auditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-audit-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'agent-2026-07-07.jsonl');
}
