import { describe, expect, it } from 'vitest';
import {
  computeLlmRetryDelay,
  retryAfterMilliseconds,
} from '../src/index.js';

describe('LLM retry policy', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(retryAfterMilliseconds('1.5', 0)).toBe(1_500);
    expect(
      retryAfterMilliseconds(
        'Wed, 21 Oct 2015 07:28:00 GMT',
        Date.parse('Wed, 21 Oct 2015 07:27:58 GMT'),
      ),
    ).toBe(2_000);
    expect(retryAfterMilliseconds('invalid', 0)).toBeUndefined();
  });

  it('applies exponential jitter, Retry-After, and the maximum delay', () => {
    expect(
      computeLlmRetryDelay({
        attempt: 2,
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        jitterRatio: 0.2,
        random: () => 0,
      }),
    ).toBe(320);
    expect(
      computeLlmRetryDelay({
        attempt: 0,
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        jitterRatio: 0,
        random: () => 0.5,
        retryAfterMs: 2_000,
      }),
    ).toBe(2_000);
    expect(
      computeLlmRetryDelay({
        attempt: 10,
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        jitterRatio: 0.2,
        random: () => 1,
        retryAfterMs: 20_000,
      }),
    ).toBe(5_000);
  });
});
