import type {
  DecodedModelContentBlock,
  ModelContentBlock,
  ModelOrigin,
  ModelReplayScope,
} from './content.js';

export type ModelFinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'unknown';

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
};

export type DecodedModelAttempt = {
  attemptId: string;
  origin: ModelOrigin;
  blocks: DecodedModelContentBlock[];
  terminal: boolean;
  finishReason?: ModelFinishReason;
  usage?: ModelTokenUsage;
  providerResponseId?: string;
  opaqueBlockRefs: string[];
};

export type ValidatedModelAttempt = DecodedModelAttempt & {
  terminal: true;
  validation: 'validated';
};

export type ModelProtocolEnvelope = {
  schemaVersion: 1;
  attemptId: string;
  origin: { connectionId: string; model: string; protocol: string };
  correlations: Array<{
    callId: string;
    draftCallKey: string;
    wireCallId?: string;
    replay: ModelReplayScope;
  }>;
  opaqueBlockRefs: string[];
};

export type CommittedModelTurn = {
  attemptId: string;
  blocks: ModelContentBlock[];
  finishReason: ModelFinishReason;
  usage?: ModelTokenUsage;
  protocolEnvelope: ModelProtocolEnvelope;
};
