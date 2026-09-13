/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- Provider doubles and Vitest asymmetric matchers are intentionally untyped. */
import { describe, expect, it } from 'vitest';
import {
  LlmProviderError,
  OpenAICompatibleProvider,
  StructuredOutputValidator,
} from '../../src/index.js';

describe('LLM security boundaries', () => {
  it('preserves an upstream error within the typed provider-error contract', async () => {
    const detail = 'upstream failure detail';
    const provider = new OpenAICompatibleProvider({
      id: 'upstream-error',
      name: 'upstream-error',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: detail } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'test' }] }))
      .rejects.toThrow(detail);
  });

  it('preserves provider error messages and details without content filtering', async () => {
    const authorizationToken = 'custom-authorization-token';
    const customSecret = 'custom-header-secret';
    const provider = new OpenAICompatibleProvider({
      id: 'header-redaction',
      name: 'header-redaction',
      apiKey: 'ordinary-api-key',
      baseUrl: 'https://example.invalid/v1',
      defaultHeaders: {
        Authorization: `Bearer ${authorizationToken}`,
        'X-Custom-Secret': customSecret,
      },
      fetch: async () => {
        throw new LlmProviderError(
          'LLM_NETWORK_ERROR',
          `upstream echoed ${authorizationToken}`,
          true,
          undefined,
          {
            nested: {
              diagnostic: `request header was ${customSecret}`,
            },
          },
        );
      },
    });

    const error = await provider
      .chat({ model: 'm', messages: [{ role: 'user', content: 'test' }] })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LlmProviderError);
    const serialized = JSON.stringify({
      message: (error as LlmProviderError).message,
      detail: (error as LlmProviderError).detail,
    });
    expect(serialized).toContain(authorizationToken);
    expect(serialized).toContain(customSecret);
  });

  it('retains the narrow Cookie-value isolation exception', async () => {
    const cookieValue = 'session=keep-isolated';
    const provider = new OpenAICompatibleProvider({
      id: 'cookie-error',
      name: 'cookie-error',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      defaultHeaders: {
        Cookie: cookieValue,
      },
      fetch: async () => {
        throw new LlmProviderError(
          'LLM_NETWORK_ERROR',
          `upstream echoed ${cookieValue}`,
          true,
        );
      },
    });

    const error = await provider
      .chat({ model: 'm', messages: [{ role: 'user', content: 'test' }] })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).message).toContain('[REDACTED]');
    expect((error as LlmProviderError).message).not.toContain(cookieValue);
  });

  it('rejects unknown tools and schema-invalid arguments before execution', () => {
    const validator = new StructuredOutputValidator();
    expect(() =>
      validator.validateToolCalls(
        [{ id: 'attack', name: 'drop_database', arguments: { force: true } }],
        [{ name: 'read_query', description: 'read', inputSchema: { type: 'object' } }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'LLM_STRUCTURED_OUTPUT_INVALID' }));
  });
});
