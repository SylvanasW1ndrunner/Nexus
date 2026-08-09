import type { PortableValue } from '@dbagent/shared';

export type ModelProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'ollama-chat';

export type ModelOrigin = {
  connectionId: string;
  model: string;
  protocol: ModelProtocol;
};

export type ModelReplayScope = 'same-connection-only' | 'compatible-protocol';

export type ModelWireIdentity =
  | { callId: string; providerItemId?: string }
  | { callId?: never; providerItemId: string };

export type CommonModelContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'resource-ref';
      artifactId: string;
      mediaType: string;
      purpose: 'input' | 'output';
    }
  | { type: 'reasoning-summary'; text: string; derivedFromOpaqueRef?: string }
  | {
      type: 'provider-opaque';
      opaqueRef: string;
      protocol: string;
      origin: { connectionId: string; model: string };
      replay: ModelReplayScope;
      value: PortableValue;
    };

export type DecodedModelContentBlock =
  | CommonModelContentBlock
  | {
      type: 'tool-call-draft';
      draftCallKey: string;
      wireIdentity?: ModelWireIdentity;
      name: string;
      arguments: PortableValue;
    };

export type ModelContentBlock =
  | CommonModelContentBlock
  | { type: 'tool-call'; callId: string; name: string; arguments: PortableValue }
  | { type: 'tool-result'; callId: string; output: PortableValue; isError: boolean };

export type ModelMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: ModelContentBlock[];
};
