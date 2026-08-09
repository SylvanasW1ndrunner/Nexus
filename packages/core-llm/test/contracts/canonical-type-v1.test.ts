import { expectTypeOf, it } from 'vitest';
import type { DecodedModelContentBlock, ModelContentBlock } from '../../src/types.js';

it('does not allow a decoded draft block in committed model content', () => {
  type Draft = Extract<DecodedModelContentBlock, { type: 'tool-call-draft' }>;
  type DraftIsCommitted = Draft extends ModelContentBlock ? true : false;

  expectTypeOf<DraftIsCommitted>().toEqualTypeOf<false>();
});
