import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRuntime, createProcessExecToolContribution, createProcessToolContributions } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())); });

describe('process prepared tools', () => {
  it('exposes process_exec and conditional process_control without legacy aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-process-tools-'));
    const runtime = new ProcessRuntime({ spoolDirectory: join(root, '.spool'), hostId: 'local' });
    cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
    const contributions = createProcessToolContributions({ rootPath: root, runtime });
    expect(contributions.map(({ definition }) => definition.name)).toEqual(['process_exec', 'process_control']);
    expect(contributions[0]?.definition).toMatchObject({ access: 'external', recoveryClass: 'non_idempotent', execution: { concurrency: 'exclusive' } });
    expect(contributions[1]?.definition).toMatchObject({ access: 'external', recoveryClass: 'non_idempotent' });
    expect(JSON.stringify(contributions.map(({ definition }) => definition.inputSchema))).not.toMatch(/process_poll|process_write|process_terminate/);
  });

  it('retains complete truncated process output outside the ordinary Agent payload', async () => {
    const spool = { stdout: { text: 'complete output', encoding: 'utf-8', fromByte: 0, toByte: 15, totalBytes: 15, truncated: false }, stderr: { text: '', encoding: 'utf-8', fromByte: 0, toByte: 0, totalBytes: 0, truncated: false }, outputComplete: true, outputReadable: true } as const;
    const readCompleteSpool = vi.fn().mockResolvedValue(spool);
    const contribution = createProcessExecToolContribution({ rootPath: '.', runtime: { readCompleteSpool } as unknown as ProcessRuntime });
    const retained = await contribution.runtime.retainResult?.({ status: 'partial', summary: 'preview', retainedOutput: true, process: { processId: 'process-large' } }, {
      hostId: 'local', sessionId: 'session', runId: 'run', signal: new AbortController().signal,
    } as never);
    expect(readCompleteSpool).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'local', sessionId: 'session', runId: 'run', processId: 'process-large' }));
    const numberMatcher: unknown = expect.any(Number);
    expect(retained).toMatchObject({ mediaType: 'application/json', expectedByteSize: numberMatcher, identity: 'process-large' });
    const chunks: Uint8Array[] = [];
    for await (const chunk of retained!.source) chunks.push(chunk);
    expect(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))).toEqual(spool);
  });
});
