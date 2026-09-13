import type { PortableValue } from '@dbagent/shared';
import type { AgentToolDescriptor } from '../types.js';

export const MAX_TOOL_ACTION_SUMMARY_CHARS = 4_096;

/**
 * Produces the only user-facing representation of a proposed Tool action.
 * Arbitrary arguments are never serialized: a Tool owner must explicitly opt
 * one string argument into presentation.inputPreview.
 */
export function createToolActionSummary(
  descriptor: AgentToolDescriptor | undefined,
  proposedName: string,
  argumentsValue: PortableValue,
): string {
  const presentation = descriptor?.presentation;
  const preparingMessage = normalizedText(presentation?.preparingMessage);
  const preview = presentation?.inputPreview;
  const previewValue = preview === undefined
    ? undefined
    : selectedStringArgument(argumentsValue, preview.argument);
  const label = normalizedText(preview?.label);

  if (previewValue !== undefined && label !== undefined) {
    const summary = [preparingMessage, `${label}:`, previewValue]
      .filter((value): value is string => value !== undefined)
      .join('\n');
    return boundedSummary(summary);
  }
  if (preview === undefined && preparingMessage !== undefined &&
    preparingMessage.length <= MAX_TOOL_ACTION_SUMMARY_CHARS) {
    return preparingMessage;
  }
  return fallbackSummary(descriptor, proposedName);
}

function selectedStringArgument(value: PortableValue, argument: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selected = (value as { [key: string]: PortableValue })[argument];
  return typeof selected === 'string' ? normalizedText(selected) : undefined;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  return normalized.length === 0 ? undefined : normalized;
}

function fallbackSummary(descriptor: AgentToolDescriptor | undefined, proposedName: string): string {
  const displayName = normalizedText(descriptor?.flatName) ??
    normalizedText(proposedName) ??
    'unknown';
  const summary = `Run tool: ${displayName}.`;
  return boundedSummary(summary);
}

function boundedSummary(value: string): string {
  if (value.length <= MAX_TOOL_ACTION_SUMMARY_CHARS) return value;
  const marker = '… [truncated]';
  let end = MAX_TOOL_ACTION_SUMMARY_CHARS - marker.length;
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return `${value.slice(0, end).trimEnd()}${marker}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
