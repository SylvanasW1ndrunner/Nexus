import type { LlmProvider, LlmToolCall } from './types.js';

export type LlmCapabilityProbeOptions = {
  model: string;
  signal?: AbortSignal;
  chatPrompt?: string;
  checkToolCalling?: boolean;
  checkStreaming?: boolean;
  maxTokens?: number;
};

export type LlmCapabilityProbeStep = {
  ok: boolean;
  detail?: string;
};

export type LlmCapabilityProbeResult = {
  providerId: string;
  providerName: string;
  model: string;
  available: LlmCapabilityProbeStep;
  chat: LlmCapabilityProbeStep & { text?: string };
  toolCalling?: LlmCapabilityProbeStep & { toolCalls?: LlmToolCall[] };
  streaming?: LlmCapabilityProbeStep & { textDeltaCount?: number };
  ok: boolean;
};

const PROBE_TOOL_NAME = 'dbagent_probe_echo';

export async function probeLlmProviderCapabilities(
  provider: LlmProvider,
  options: LlmCapabilityProbeOptions,
): Promise<LlmCapabilityProbeResult> {
  const available = await probeAvailability(provider);
  const chat = await probeChat(provider, options);
  const toolCalling = options.checkToolCalling ? await probeToolCalling(provider, options) : undefined;
  const streaming = options.checkStreaming ? await probeStreaming(provider, options) : undefined;
  const steps = [available, chat, toolCalling, streaming].filter((step): step is LlmCapabilityProbeStep => step !== undefined);

  return {
    providerId: provider.id,
    providerName: provider.name,
    model: options.model,
    available,
    chat,
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(streaming === undefined ? {} : { streaming }),
    ok: steps.every((step) => step.ok),
  };
}

async function probeAvailability(provider: LlmProvider): Promise<LlmCapabilityProbeStep> {
  try {
    const result = await provider.isAvailable();
    return {
      ok: result.available,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

async function probeChat(
  provider: LlmProvider,
  options: LlmCapabilityProbeOptions,
): Promise<LlmCapabilityProbeResult['chat']> {
  try {
    const response = await provider.chat({
      model: options.model,
      messages: [{ role: 'user', content: options.chatPrompt ?? '只回答 READY' }],
      temperature: 0,
      maxTokens: options.maxTokens ?? 32,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const text = response.text.trim();
    return {
      ok: text.length > 0,
      text,
      ...(text.length > 0 ? {} : { detail: 'Provider returned an empty chat response.' }),
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

async function probeToolCalling(
  provider: LlmProvider,
  options: LlmCapabilityProbeOptions,
): Promise<NonNullable<LlmCapabilityProbeResult['toolCalling']>> {
  try {
    const response = await provider.chat({
      model: options.model,
      messages: [
        {
          role: 'user',
          content: `Call the ${PROBE_TOOL_NAME} tool with {"value":"ok"}. Do not answer in text.`,
        },
      ],
      tools: [
        {
          name: PROBE_TOOL_NAME,
          description: 'Echo a probe value so DBAgent can verify tool calling support.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      temperature: 0,
      maxTokens: options.maxTokens ?? 64,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const matched = response.toolCalls.some((call) => call.name === PROBE_TOOL_NAME);
    return {
      ok: matched,
      toolCalls: response.toolCalls,
      ...(matched ? {} : { detail: `Provider did not call ${PROBE_TOOL_NAME}.` }),
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

async function probeStreaming(
  provider: LlmProvider,
  options: LlmCapabilityProbeOptions,
): Promise<NonNullable<LlmCapabilityProbeResult['streaming']>> {
  if (!provider.stream) {
    return { ok: false, detail: 'Provider does not implement streaming.' };
  }

  try {
    let textDeltaCount = 0;
    let finished = false;
    for await (const event of provider.stream({
      model: options.model,
      messages: [{ role: 'user', content: '只回答 STREAM_READY' }],
      temperature: 0,
      maxTokens: options.maxTokens ?? 32,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      if (event.type === 'text-delta' && event.text.length > 0) textDeltaCount += 1;
      if (event.type === 'finish') finished = true;
    }
    return {
      ok: finished && textDeltaCount > 0,
      textDeltaCount,
      ...(finished && textDeltaCount > 0 ? {} : { detail: 'Provider stream did not produce text and finish events.' }),
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
