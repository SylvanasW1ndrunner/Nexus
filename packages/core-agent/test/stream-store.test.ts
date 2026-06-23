import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmProviderError } from '@dbagent/core-llm';
import { AgentStreamStore, persistAgentStreamEvents } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentStreamStore', () => {
  it('persists stream chunks and final response for a completed Agent response', async () => {
    const store = new AgentStreamStore(await streamPath());
    const stream = await store.start({
      id: 'stream_complete',
      sessionId: 'session_stream',
      roundId: 'round_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });

    await store.appendEvent(stream.id, { type: 'text-delta', text: '订单' }, '2026-06-23T11:00:01.000Z');
    await store.appendEvent(stream.id, { type: 'text-delta', text: '总数是 42。' }, '2026-06-23T11:00:02.000Z');
    await store.appendEvent(
      stream.id,
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      '2026-06-23T11:00:03.000Z',
    );
    await store.appendEvent(
      stream.id,
      {
        type: 'finish',
        response: {
          text: '订单总数是 42。',
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: 'deepseek-ai/DeepSeek-V4-Pro',
        },
        reason: 'stop',
      },
      '2026-06-23T11:00:04.000Z',
    );

    await expect(store.load('stream_complete')).resolves.toMatchObject({
      status: 'complete',
      text: '订单总数是 42。',
      usage: { totalTokens: 15 },
      finishedAt: '2026-06-23T11:00:04.000Z',
      chunks: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }],
    });
    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('keeps partial text recoverable when a stream is interrupted', async () => {
    const store = new AgentStreamStore(await streamPath());
    await store.start({
      id: 'stream_interrupted',
      sessionId: 'session_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });
    await store.appendEvent('stream_interrupted', { type: 'text-delta', text: '已经查询订单，' }, '2026-06-23T11:00:01.000Z');
    await store.appendEvent('stream_interrupted', { type: 'text-delta', text: '准备继续分析退款。' }, '2026-06-23T11:00:02.000Z');
    await store.markIncomplete('stream_interrupted', 'network reset during stream', '2026-06-23T11:00:03.000Z');

    await expect(store.listRecoverable()).resolves.toMatchObject([
      {
        id: 'stream_interrupted',
        status: 'incomplete',
        text: '已经查询订单，准备继续分析退款。',
        errorMessage: 'network reset during stream',
      },
    ]);
  });

  it('does not treat user-aborted streams as recoverable work', async () => {
    const store = new AgentStreamStore(await streamPath());
    await store.start({
      id: 'stream_aborted',
      sessionId: 'session_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });
    await store.appendEvent('stream_aborted', { type: 'text-delta', text: '用户停止前的部分输出' }, '2026-06-23T11:00:01.000Z');
    await store.markAborted('stream_aborted', '用户点击停止', '2026-06-23T11:00:02.000Z');

    await expect(store.load('stream_aborted')).resolves.toMatchObject({
      status: 'aborted',
      text: '用户停止前的部分输出',
      errorMessage: '用户点击停止',
    });
    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('redacts secrets from persisted stream events and final responses', async () => {
    const store = new AgentStreamStore(await streamPath());
    const apiKey = ['sk', 'stream-secret-123456'].join('-');
    await store.start({
      id: 'stream_redacted',
      sessionId: 'session_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });
    await store.appendEvent(
      'stream_redacted',
      {
        type: 'tool-call',
        toolCall: {
          id: 'call_provider',
          name: 'configure_provider',
          arguments: { apiKey, authorization: `Bearer token-stream-secret-123456` },
        },
      },
      '2026-06-23T11:00:01.000Z',
    );
    await store.markFailed('stream_redacted', `provider failed ${apiKey}`, '2026-06-23T11:00:02.000Z');

    const serialized = JSON.stringify(await store.load('stream_redacted'));

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('token-stream-secret-123456');
    expect(serialized).toContain('[REDACTED]');
  });

  it('treats corrupt stream JSON as empty so startup can continue', async () => {
    const filePath = await streamPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');
    const store = new AgentStreamStore(filePath);

    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('persists events while forwarding a provider stream and marks network interruption incomplete', async () => {
    const store = new AgentStreamStore(await streamPath());
    await store.start({
      id: 'stream_wrapped',
      sessionId: 'session_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });

    await expect(
      collect(
        persistAgentStreamEvents(store, 'stream_wrapped', interruptedEvents(), fixedNow('2026-06-23T11:00:01.000Z')),
      ),
    ).rejects.toThrow('network reset');

    await expect(store.load('stream_wrapped')).resolves.toMatchObject({
      status: 'incomplete',
      text: 'partial response',
      errorMessage: 'network reset',
    });
  });

  it('marks wrapped user-aborted provider streams as aborted instead of recoverable', async () => {
    const store = new AgentStreamStore(await streamPath());
    await store.start({
      id: 'stream_wrapped_abort',
      sessionId: 'session_stream',
      providerId: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      now: '2026-06-23T11:00:00.000Z',
    });

    await expect(
      collect(
        persistAgentStreamEvents(store, 'stream_wrapped_abort', abortedEvents(), fixedNow('2026-06-23T11:00:01.000Z')),
      ),
    ).rejects.toThrow('user stopped');

    await expect(store.load('stream_wrapped_abort')).resolves.toMatchObject({
      status: 'aborted',
      text: 'partial response',
      errorMessage: 'user stopped',
    });
    await expect(store.listRecoverable()).resolves.toEqual([]);
  });
});

async function streamPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-agent-streams-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'agent-streams.json');
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function* interruptedEvents() {
  yield { type: 'text-delta' as const, text: 'partial response' };
  throw new Error('network reset');
}

async function* abortedEvents() {
  yield { type: 'text-delta' as const, text: 'partial response' };
  throw new LlmProviderError('LLM_ABORTED', 'user stopped', false);
}

function fixedNow(value: string): () => string {
  return () => value;
}
