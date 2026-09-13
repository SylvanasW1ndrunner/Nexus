import { LlmProviderError } from '@dbagent/core-llm';
import { describe, expect, it } from 'vitest';
import { AgentRuntimeError } from '../src/errors.js';
import { asDatabaseCapabilityError } from '@dbagent/database-capability';

describe('Agent host LLM error mapping', () => {
  it('publishes durable command and driver failure codes at the Agent boundary', () => {
    expect(new AgentRuntimeError('COMMAND_CONFLICT', 'conflicting command')).toMatchObject({
      code: 'COMMAND_CONFLICT',
    });
    expect(new AgentRuntimeError('RUNTIME_DRIVER_FAILED', 'driver failed', true)).toMatchObject({
      code: 'RUNTIME_DRIVER_FAILED', retryable: true,
    });
  });
  it('preserves cancellation as a non-retryable Agent abort', () => {
    expect(asDatabaseCapabilityError(new LlmProviderError('LLM_ABORTED', 'cancelled', false))).toMatchObject({
      code: 'ABORTED',
      retryable: false,
    });
  });

  it('maps invalid model output separately from transport failures', () => {
    expect(
      asDatabaseCapabilityError(new LlmProviderError('LLM_STRUCTURED_OUTPUT_INVALID', 'invalid JSON', false)),
    ).toMatchObject({ code: 'LLM_RESPONSE_INVALID', retryable: false });
    expect(asDatabaseCapabilityError(new LlmProviderError('LLM_RATE_LIMITED', 'limited', true))).toMatchObject({
      code: 'LLM_REQUEST_FAILED',
      retryable: true,
    });
  });
});
