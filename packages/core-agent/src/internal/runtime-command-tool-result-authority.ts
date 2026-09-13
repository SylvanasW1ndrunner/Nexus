import type { PortableValue } from '@dbagent/shared';
import { snapshotRuntimeCommandPayload } from '../tool-result.js';
import type {
  RuntimeCommandIntent,
  RuntimeCommandToolContent,
  RuntimeCommandToolResult,
} from '../runtime-command-tool-result.js';

export type SealedRuntimeCommandToolResult = Readonly<{
  command: RuntimeCommandIntent;
  result: PortableValue;
  content?: RuntimeCommandToolContent;
}>;

const sealedResults = new WeakMap<object, SealedRuntimeCommandToolResult>();
const MAX_RETAINED_CONTENT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_CONTENT_TYPE_CHARS = 1_024;
const MAX_RETAINED_CONTENT_REFERENCE_FIELD_CHARS = 128;

export function sealRuntimeCommandToolResult(
  command: RuntimeCommandIntent,
  result: PortableValue,
  content?: RuntimeCommandToolContent,
): RuntimeCommandToolResult {
  const holder = Object.freeze(Object.create(null) as object);
  const contentSnapshot = content === undefined
    ? undefined
    : snapshotRetainedContent(content);
  sealedResults.set(holder, Object.freeze({
    command: snapshotRuntimeCommandPayload(command) as RuntimeCommandIntent,
    result: snapshotRuntimeCommandPayload(result),
    ...(contentSnapshot === undefined ? {} : { content: contentSnapshot }),
  }));
  return holder as RuntimeCommandToolResult;
}

/** Retained content has a distinct 4 MiB byte contract from Handler payloads. */
function snapshotRetainedContent(content: RuntimeCommandToolContent): RuntimeCommandToolContent {
  if (
    content === null || typeof content !== 'object' || Array.isArray(content) ||
    Object.keys(content).length !== 3 ||
    !Object.hasOwn(content, 'body') || !Object.hasOwn(content, 'contentType') ||
    !Object.hasOwn(content, 'referenceField') ||
    typeof content.body !== 'string' || typeof content.contentType !== 'string' ||
    typeof content.referenceField !== 'string' ||
    Buffer.byteLength(content.body, 'utf8') > MAX_RETAINED_CONTENT_BODY_BYTES ||
    content.contentType.length === 0 || content.contentType.length > MAX_RETAINED_CONTENT_TYPE_CHARS ||
    content.referenceField.length === 0 || content.referenceField.length > MAX_RETAINED_CONTENT_REFERENCE_FIELD_CHARS
  ) {
    throw new TypeError('Runtime retained content is invalid or exceeds its 4 MiB bound.');
  }
  return Object.freeze({
    body: content.body,
    contentType: content.contentType,
    referenceField: content.referenceField,
  });
}

/** Clones and shaped external values never acquire the holder's exact identity. */
export function readSealedRuntimeCommandToolResult(value: unknown): SealedRuntimeCommandToolResult | undefined {
  return value !== null && typeof value === 'object' ? sealedResults.get(value) : undefined;
}
