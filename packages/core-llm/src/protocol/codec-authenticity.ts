import type { ModelProtocolCodec } from './codec.js';

const AUTHENTIC_CODECS = new WeakSet<ModelProtocolCodec>();

/** Internal construction-time capability; deliberately not re-exported by the package. */
export function bindModelProtocolCodec(codec: ModelProtocolCodec): void {
  AUTHENTIC_CODECS.add(codec);
}

export function isAuthenticModelProtocolCodec(codec: ModelProtocolCodec): boolean {
  return AUTHENTIC_CODECS.has(codec);
}
