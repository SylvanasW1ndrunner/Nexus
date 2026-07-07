import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAuditLogStore } from '@dbagent/core-agent';
import { DailyAgentAuditLogStore, agentAuditDate, agentAuditLogPath } from './agent-audit-log.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DailyAgentAuditLogStore', () => {
  it('derives stable daily audit log paths from event timestamps', async () => {
    const logsDir = await tempDir();

    expect(agentAuditDate('2026-07-07T10:30:00.000Z')).toBe('2026-07-07');
    expect(agentAuditDate('not-a-date')).toBe('unknown-date');
    expect(agentAuditLogPath(logsDir, '2026-07-07T10:30:00.000Z')).toBe(
      join(logsDir, 'agent-2026-07-07.jsonl'),
    );
  });

  it('writes redacted Agent audit events to the dated desktop log file', async () => {
    const logsDir = await tempDir();
    const store = new DailyAgentAuditLogStore(logsDir);
    const apiKey = ['sk', 'desktop-audit-secret-123456'].join('-');
    const databaseUrl = 'postgresql://tester:localpass@127.0.0.1/app';

    await store.append({
      type: 'tool_call_started',
      timestamp: '2026-07-07T10:30:00.000Z',
      sessionId: 'session_desktop_audit',
      iteration: 1,
      toolCallId: 'call_secret',
      toolName: 'query_database',
      argumentPreview: JSON.stringify({ apiKey, databaseUrl, sql: 'select 1' }),
    });

    const filePath = join(logsDir, 'agent-2026-07-07.jsonl');
    const raw = await readFile(filePath, 'utf8');
    const events = await new AgentAuditLogStore(filePath).readAll();

    expect(raw).toContain('tool_call_started');
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(events)).not.toContain('localpass');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-audit-'));
  tempDirs.push(dir);
  return dir;
}
