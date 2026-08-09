import type { ModelProtocolCodec } from './codec.js';
import type { CanonicalModelProtocol } from './content.js';
import { anthropicMessagesCodec } from './codecs/anthropic-messages.js';
import { ollamaChatCodec } from './codecs/ollama-chat.js';
import { openAIChatCodec } from './codecs/openai-chat.js';
import { openAIResponsesCodec } from './codecs/openai-responses.js';

export type ModelCodecRegistryErrorCode = 'MODEL_CODEC_UNAVAILABLE';

export class ModelCodecRegistryError extends Error {
  readonly code = 'MODEL_CODEC_UNAVAILABLE' as const;

  constructor(protocol: string, revision: string) {
    super(`No registered Model Protocol codec matches ${protocol} at revision ${revision}.`);
    this.name = 'ModelCodecRegistryError';
  }
}

export const MODEL_PROTOCOL_CODEC_REVISIONS: Readonly<
  Record<CanonicalModelProtocol, string>
> = Object.freeze({
  'openai-chat': openAIChatCodec.revision,
  'openai-responses': openAIResponsesCodec.revision,
  'anthropic-messages': anthropicMessagesCodec.revision,
  'ollama-chat': ollamaChatCodec.revision,
});

export const MODEL_PROTOCOL_CODEC_REGISTRY: ReadonlyMap<string, ModelProtocolCodec> = new Map<
  string,
  ModelProtocolCodec
>([
  [openAIChatCodec.revision, openAIChatCodec],
  [openAIResponsesCodec.revision, openAIResponsesCodec],
  [anthropicMessagesCodec.revision, anthropicMessagesCodec],
  [ollamaChatCodec.revision, ollamaChatCodec],
]);

export function resolveModelProtocolCodec(
  protocol: string,
  revision: string,
): ModelProtocolCodec {
  const codec = MODEL_PROTOCOL_CODEC_REGISTRY.get(revision);
  if (codec === undefined || codec.protocol !== protocol || codec.revision !== revision) {
    throw new ModelCodecRegistryError(protocol, revision);
  }
  return codec;
}
