import {
  LlmProviderError,
  type LlmProvider,
} from '../../src/index.js';

export type ProviderContractOptions = {
  model: string;
  requireUsage?: boolean;
};

export type ProviderContractReport = {
  providerId: string;
  protocol: string;
  generation: { ok: boolean; detail?: string };
  cancellation: { ok: boolean; latencyMs: number; detail?: string };
  usage: { ok: boolean; detail?: string };
  ok: boolean;
};

export async function runProviderContractSuite(
  provider: LlmProvider,
  options: ProviderContractOptions,
): Promise<ProviderContractReport> {
  let generation: ProviderContractReport['generation'];
  let usage: ProviderContractReport['usage'];
  try {
    const response = await provider.chat({
      model: options.model,
      messages: [{ role: 'user', content: 'contract input' }],
      temperature: 0,
      maxTokens: 8,
    });
    generation = response.text || response.toolCalls.length > 0
      ? { ok: true }
      : { ok: false, detail: 'Provider returned an empty response.' };
    usage = options.requireUsage === false || response.usage
      ? { ok: true }
      : { ok: false, detail: 'Provider did not return token usage.' };
  } catch (error) {
    generation = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    usage = { ok: false, detail: 'Generation failed before token usage could be checked.' };
  }
  const cancellation = await probeCancellation(provider, options.model);
  return {
    providerId: provider.id,
    protocol: provider.protocol ?? 'custom',
    generation,
    cancellation,
    usage,
    ok: generation.ok && cancellation.ok && usage.ok,
  };
}

async function probeCancellation(
  provider: LlmProvider,
  model: string,
): Promise<ProviderContractReport['cancellation']> {
  const controller = new AbortController();
  controller.abort();
  const startedAt = performance.now();
  try {
    await provider.chat({
      model,
      messages: [{ role: 'user', content: 'This request must be cancelled.' }],
      maxTokens: 8,
      signal: controller.signal,
    });
    return {
      ok: false,
      latencyMs: performance.now() - startedAt,
      detail: 'Provider completed a pre-aborted request.',
    };
  } catch (error) {
    const ok = error instanceof LlmProviderError && error.code === 'LLM_ABORTED';
    return {
      ok,
      latencyMs: performance.now() - startedAt,
      ...(ok ? {} : { detail: error instanceof Error ? error.message : String(error) }),
    };
  }
}
