import type { DecodedModelContentBlock, ModelWireIdentity } from './content.js';
import type { DecodedModelAttempt, ModelTokenUsage } from './envelope.js';

export type DecodedModelStreamEvent =
  | { type: 'text-delta'; blockOrdinal: number; text: string }
  | { type: 'reasoning-summary-delta'; blockOrdinal: number; text: string }
  | {
      type: 'tool-call-delta';
      blockOrdinal: number;
      draftCallKey: string;
      wireIdentity?: ModelWireIdentity | undefined;
      name?: string | undefined;
      argumentsDelta?: string | undefined;
    }
  | { type: 'block-complete'; blockOrdinal: number; block: DecodedModelContentBlock }
  | { type: 'usage'; usage: ModelTokenUsage }
  | { type: 'finish'; attempt: DecodedModelAttempt };
