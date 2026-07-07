import { join } from 'node:path';
import { AgentAuditLogStore, type AgentAuditEvent, type AgentAuditLogWriter } from '@dbagent/core-agent';

const FALLBACK_DATE = 'unknown-date';

export class DailyAgentAuditLogStore implements AgentAuditLogWriter {
  constructor(private readonly logsDir: string) {}

  async append(event: AgentAuditEvent): Promise<void> {
    await new AgentAuditLogStore(agentAuditLogPath(this.logsDir, event.timestamp)).append(event);
  }
}

export function agentAuditLogPath(logsDir: string, timestamp: string): string {
  return join(logsDir, `agent-${agentAuditDate(timestamp)}.jsonl`);
}

export function agentAuditDate(timestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
  return match?.[1] ?? FALLBACK_DATE;
}
