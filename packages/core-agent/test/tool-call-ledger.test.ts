import { describe, expect, it } from 'vitest';
import { AgentToolCallLedger, type AgentToolExecutionRecord } from '../src/index.js';

const record: AgentToolExecutionRecord = {
  toolCallId: 'call-1',
  toolName: 'query_database',
  status: 'success',
  durationMs: 2,
  resultPreview: '{"rows":[{"value":1}]}',
};

describe('AgentToolCallLedger', () => {
  it('replays one completed call id but treats a new id as a new action', () => {
    const ledger = new AgentToolCallLedger();
    const call = {
      id: 'call-1',
      name: 'query_database',
      arguments: { sql: 'select 1', options: { timeout: 10 } },
    };

    expect(ledger.claim(call)).toEqual({ kind: 'execute' });
    ledger.complete(call, {
      record,
      persistedContent: record.resultPreview,
      modelContent: record.resultPreview,
    });
    expect(
      ledger.claim({
        ...call,
        arguments: { options: { timeout: 10 }, sql: 'select 1' },
      }),
    ).toMatchObject({ kind: 'replay', outcome: { record } });
    expect(ledger.claim({ ...call, id: 'call-2' })).toEqual({ kind: 'execute' });
  });

  it('rejects one call id reused with different arguments', () => {
    const ledger = new AgentToolCallLedger();
    expect(
      ledger.claim({ id: 'call-1', name: 'query_database', arguments: { sql: 'select 1' } }),
    ).toEqual({ kind: 'execute' });

    expect(
      ledger.claim({ id: 'call-1', name: 'query_database', arguments: { sql: 'select 2' } }),
    ).toMatchObject({ kind: 'conflict' });
  });
});
