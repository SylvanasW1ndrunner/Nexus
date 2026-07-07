import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import { redactPersistedAgentString, redactPersistedAgentValue } from './redaction.js';
import type { AgentMode, AgentRunStatus, AgentToolExecutionRecord } from './types.js';

const MAX_AUDIT_STRING_CHARS = 4_000;

export type AgentAuditRunStatus = AgentRunStatus | 'failed';

export type AgentAuditEvent =
  | {
      type: 'run_started';
      timestamp: string;
      sessionId: string;
      mode: AgentMode;
      usageMode: UsageMode;
      maxIterations: number;
      allowedTools?: string[];
    }
  | {
      type: 'model_call_started';
      timestamp: string;
      sessionId: string;
      iteration: number;
      providerId: string;
      model: string;
      toolCount: number;
    }
  | {
      type: 'model_call_finished';
      timestamp: string;
      sessionId: string;
      iteration: number;
      providerId: string;
      model: string;
      durationMs: number;
      toolCallCount: number;
      textChars: number;
      usage?: LlmUsage;
    }
  | {
      type: 'tool_call_started';
      timestamp: string;
      sessionId: string;
      iteration: number;
      toolCallId: string;
      toolName: string;
      argumentPreview?: string;
    }
  | {
      type: 'tool_call_finished';
      timestamp: string;
      sessionId: string;
      iteration: number;
      toolCallId: string;
      toolName: string;
      status: AgentToolExecutionRecord['status'];
      durationMs: number;
      resultPreview: string;
    }
  | {
      type: 'run_finished';
      timestamp: string;
      sessionId: string;
      status: AgentAuditRunStatus;
      iterations: number;
      durationMs: number;
      finalTextPreview?: string;
      errorMessage?: string;
    };

export type AgentAuditLogWriter = {
  append(event: AgentAuditEvent): Promise<void>;
};

export class AgentAuditLogStore implements AgentAuditLogWriter {
  constructor(private readonly filePath: string) {}

  async append(event: AgentAuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const safeEvent = normalizeAuditEvent(event);
    await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, 'utf8');
  }

  async readAll(): Promise<AgentAuditEvent[]> {
    let content = '';
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }

    const events: AgentAuditEvent[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(normalizeAuditEvent(JSON.parse(line) as AgentAuditEvent));
      } catch {
        // JSONL 审计日志允许跳过损坏行，避免单行写入异常影响后续诊断。
      }
    }
    return events;
  }

  async readRecent(limit: number): Promise<AgentAuditEvent[]> {
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const events = await this.readAll();
    return events.slice(-normalizedLimit);
  }
}

function normalizeAuditEvent(event: AgentAuditEvent): AgentAuditEvent {
  return boundAuditValue(redactPersistedAgentValue(event)) as AgentAuditEvent;
}

function boundAuditValue(value: unknown): unknown {
  if (typeof value === 'string') return truncateAuditString(redactPersistedAgentString(value));
  if (Array.isArray(value)) return value.map((item) => boundAuditValue(item));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = boundAuditValue(child);
  }
  return output;
}

function truncateAuditString(value: string): string {
  if (value.length <= MAX_AUDIT_STRING_CHARS) return value;
  const suffix = '...[truncated]';
  return `${value.slice(0, MAX_AUDIT_STRING_CHARS - suffix.length)}${suffix}`;
}
