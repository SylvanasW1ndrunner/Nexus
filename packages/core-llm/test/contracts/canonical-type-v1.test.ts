import { expectTypeOf, it } from 'vitest';
import type {
  DecodedModelContentBlock,
  ModelContentBlock,
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
