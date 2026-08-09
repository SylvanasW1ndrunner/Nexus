import { expectTypeOf, it } from 'vitest';
import type { PortableValue } from '@dbagent/shared';
import type {
  DecodedModelContentBlock,
  DecodedModelStreamEvent,
  ModelContentBlock,
  ModelProtocol,
  ModelWireIdentity,
} from '../../src/types.js';

it('does not allow a decoded draft block in committed model content', () => {
  type Draft = Extract<DecodedModelContentBlock, { type: 'tool-call-draft' }>;
  type DraftIsCommitted = Draft extends ModelContentBlock ? true : false;

  expectTypeOf<DraftIsCommitted>().toEqualTypeOf<false>();
});

it('requires at least one native component in a model wire identity', () => {
  type EmptyIsWireIdentity = Record<never, never> extends ModelWireIdentity ? true : false;

  expectTypeOf<EmptyIsWireIdentity>().toEqualTypeOf<false>();
});

it('carries provider-native tentative fragments without projecting them as text', () => {
  type OpaqueDelta = Extract<DecodedModelStreamEvent, { type: 'provider-opaque-delta' }>;

  expectTypeOf<OpaqueDelta>().toEqualTypeOf<{
    type: 'provider-opaque-delta';
    blockOrdinal: number;
    opaqueRef: string;
    protocol: ModelProtocol;
    fragment: PortableValue;
  }>();
});
