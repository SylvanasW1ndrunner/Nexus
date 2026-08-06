import type { LlmToolCall } from '@dbagent/core-llm';
import type { AgentToolExecutionRecord } from './types.js';

export type AgentToolCallOutcome = {
  record: AgentToolExecutionRecord;
  /** Durable Tool message stored in the Session. */
  persistedContent: string;
  /** Bounded projection sent back to the model for this run. */
  modelContent: string;
};

export type AgentToolCallClaim =
  | { kind: 'execute' }
  | { kind: 'pending' }
  | { kind: 'replay'; outcome: AgentToolCallOutcome }
  | { kind: 'conflict'; message: string };

type LedgerEntry = {
  signature: string;
  toolName: string;
  outcome?: AgentToolCallOutcome;
};

/** Run-scoped idempotency boundary for Provider Tool Call identifiers. */
export class AgentToolCallLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  claim(call: LlmToolCall): AgentToolCallClaim {
    const signature = callSignature(call);
    const existing = this.entries.get(call.id);
    if (!existing) {
      this.entries.set(call.id, { signature, toolName: call.name });
      return { kind: 'execute' };
    }
    if (existing.signature !== signature || existing.toolName !== call.name) {
      return {
        kind: 'conflict',
        message: `Tool call id ${call.id} was reused with different tool arguments. The duplicate call was not executed.`,
      };
    }
    return existing.outcome
      ? { kind: 'replay', outcome: cloneOutcome(existing.outcome) }
      : { kind: 'pending' };
  }

  complete(call: LlmToolCall, outcome: AgentToolCallOutcome): void {
    const existing = this.entries.get(call.id);
    const signature = callSignature(call);
    if (!existing || existing.signature !== signature || existing.toolName !== call.name) {
      throw new Error(`Cannot complete unclaimed Tool Call: ${call.id}`);
    }
    if (!existing.outcome) existing.outcome = cloneOutcome(outcome);
  }
}

function callSignature(call: LlmToolCall): string {
  return `${call.name}:${stableJson(call.arguments)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function cloneOutcome(outcome: AgentToolCallOutcome): AgentToolCallOutcome {
  return {
    record: structuredClone(outcome.record),
    persistedContent: outcome.persistedContent,
    modelContent: outcome.modelContent,
  };
}
