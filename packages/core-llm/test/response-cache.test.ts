import { describe, expect, it } from 'vitest';
import { LlmResponseCache, type LlmChatRequest, type LlmChatResponse } from '../src/index.js';

describe('LlmResponseCache', () => {
  it('deep-clones nested tool arguments on both cache writes and reads', () => {
    const cache = new LlmResponseCache();
    const request: LlmChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'inspect orders' }],
    };
    const response: LlmChatResponse = {
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'query',
          arguments: {
            query: {
              filters: [{ column: 'status', values: ['open'] }],
            },
          },
        },
      ],
    };

    cache.set('tenant-1', 'provider-1', request, response);
    const sourceArguments = response.toolCalls[0]?.arguments as {
      query: { filters: Array<{ column: string; values: string[] }> };
    };
    sourceArguments.query.filters[0]?.values.push('closed');

    const first = cache.get('tenant-1', 'provider-1', request);
    const firstArguments = first?.toolCalls[0]?.arguments as {
      query: { filters: Array<{ column: string; values: string[] }> };
    };
    expect(firstArguments.query.filters[0]?.values).toEqual(['open']);

    firstArguments.query.filters[0]?.values.push('cancelled');
    const second = cache.get('tenant-1', 'provider-1', request);
    const secondArguments = second?.toolCalls[0]?.arguments as {
      query: { filters: Array<{ column: string; values: string[] }> };
    };
    expect(secondArguments.query.filters[0]?.values).toEqual(['open']);
  });

  it('isolates otherwise-identical entries by provider', () => {
    const cache = new LlmResponseCache();
    const request: LlmChatRequest = {
      model: 'shared-model',
      messages: [{ role: 'user', content: 'same request' }],
    };

    cache.set('tenant-1', 'provider-a', request, { text: 'from a', toolCalls: [] });
    cache.set('tenant-1', 'provider-b', request, { text: 'from b', toolCalls: [] });

    expect(cache.get('tenant-1', 'provider-a', request)?.text).toBe('from a');
    expect(cache.get('tenant-1', 'provider-b', request)?.text).toBe('from b');
  });

  it('does not retain an oversized response or an older value for the same key', () => {
    const cache = new LlmResponseCache({
      maxEntryBytes: 128,
      maxTotalBytes: 1_024,
    });
    const request: LlmChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'bounded response' }],
    };

    cache.set('tenant-1', 'provider-1', request, { text: 'small', toolCalls: [] });
    expect(cache.get('tenant-1', 'provider-1', request)?.text).toBe('small');

    cache.set('tenant-1', 'provider-1', request, {
      text: 'x'.repeat(512),
      toolCalls: [],
    });

    expect(cache.get('tenant-1', 'provider-1', request)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('evicts least-recently-used responses to enforce the total byte budget', () => {
    let now = 0;
    const cache = new LlmResponseCache({
      maxEntries: 10,
      maxEntryBytes: 1_024,
      maxTotalBytes: 600,
      now: () => {
        now += 1;
        return now;
      },
    });
    const request = (content: string): LlmChatRequest => ({
      model: 'test-model',
      messages: [{ role: 'user', content }],
    });
    const response = (text: string): LlmChatResponse => ({
      text: text.repeat(160),
      toolCalls: [],
    });

    cache.set('tenant-1', 'provider-1', request('one'), response('a'));
    cache.set('tenant-1', 'provider-1', request('two'), response('b'));
    expect(cache.get('tenant-1', 'provider-1', request('one'))?.text).toBe('a'.repeat(160));

    cache.set('tenant-1', 'provider-1', request('three'), response('c'));

    expect(cache.get('tenant-1', 'provider-1', request('one'))?.text).toBe('a'.repeat(160));
    expect(cache.get('tenant-1', 'provider-1', request('two'))).toBeUndefined();
    expect(cache.get('tenant-1', 'provider-1', request('three'))?.text).toBe('c'.repeat(160));
    expect(cache.size()).toBe(2);
  });
});
