import { LlmProviderError } from '@dbagent/core-llm';
import { describe, expect, it } from 'vitest';
import { asDatabaseAgentError } from '../src/index.js';

describe('SDK LLM error mapping', () => {
  it('preserves cancellation as a non-retryable SDK abort', () => {
    expect(asDatabaseAgentError(new LlmProviderError('LLM_ABORTED', 'cancelled', false))).toMatchObject({
      code: 'ABORTED',
      retryable: false,
    });
  });

  it('maps invalid model output separately from transport failures', () => {
    expect(
      asDatabaseAgentError(new LlmProviderError('LLM_STRUCTURED_OUTPUT_INVALID', 'invalid JSON', false)),
    ).toMatchObject({ code: 'LLM_RESPONSE_INVALID', retryable: false });
    expect(asDatabaseAgentError(new LlmProviderError('LLM_RATE_LIMITED', 'limited', true))).toMatchObject({
      code: 'LLM_REQUEST_FAILED',
      retryable: true,
    });
  });
});
