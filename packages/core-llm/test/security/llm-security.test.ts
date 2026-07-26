/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- Provider doubles and Vitest asymmetric matchers are intentionally untyped. */
import { describe, expect, it } from 'vitest';
import {
  LlmGateway,
  LlmProviderError,
  OpenAICompatibleProvider,
  StructuredOutputValidator,
  type LlmProvider,
} from '../../src/index.js';

describe('LLM security boundaries', () => {
  it('does not expose a credential echoed by an upstream error', async () => {
    const secret = 'sk-super-secret-value';
    const provider = new OpenAICompatibleProvider({
      id: 'redaction',
      name: 'redaction',
      apiKey: secret,
      baseUrl: 'https://example.invalid/v1',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: `invalid credential ${secret}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(
      provider.chat({ model: 'm', messages: [{ role: 'user', content: 'test' }] }),
    ).rejects.not.toThrow(secret);
  });

  it('redacts sensitive default header values from error messages and nested details', async () => {
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
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain(authorizationToken);
    expect(serialized).not.toContain(customSecret);
  });

  it('stores no prompt, response, user id or tenant id in telemetry', async () => {
    const gateway = new LlmGateway();
    gateway.registerProvider(okProvider(), [{ model: 'm' }]);
    const result = await gateway.execute({
      providerId: 'safe',
      request: { model: 'm', messages: [{ role: 'user', content: 'sensitive customer prompt' }] },
      context: { tenantId: 'secret-tenant', userId: 'private-user', taskType: 'security' },
      maxRetries: 0,
      maxFallbacks: 0,
    });
    const serialized = JSON.stringify(gateway.telemetry.list({ requestId: result.requestId }));
    expect(serialized).not.toContain('sensitive customer prompt');
    expect(serialized).not.toContain('secret-tenant');
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('safe response');
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

function okProvider(): LlmProvider {
  return {
    id: 'safe',
    name: 'safe',
    mode: 'private',
    async chat() {
      return {
        text: 'safe response',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}
