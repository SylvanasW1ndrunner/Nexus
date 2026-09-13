import { createHash } from 'node:crypto';
import type { AgentEvent } from '../events/agent-event.js';
import { normalizeAgentEvidenceRefs } from '../evidence-reference.js';
import type {
  DeliveryEvidenceSelection,
  DeliveryEvidenceSnapshot,
  DeliveryToolEvidenceSnapshot,
} from './delivery-verifier.js';

export type CreateDeliveryEvidenceSnapshotInput = Readonly<{
  events: readonly AgentEvent[];
  evidenceRevision: number;
  finalContentRef: string;
  finalText: string;
}>;

/**
 * Creates the immutable delivery binding from committed facts only. Fallback
 * selection intentionally chooses one latest advancing Observation instead of
 * accumulating unrelated historical references from the complete Run.
 */
export function createDeliveryEvidenceSnapshot(
  input: CreateDeliveryEvidenceSnapshotInput,
): DeliveryEvidenceSnapshot {
  if (
    !Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 0 ||
    input.finalContentRef.trim() === '' || input.finalContentRef.length > 4_096 ||
    input.finalText.trim() === '' || input.finalText.length > 65_536
  ) {
    throw new TypeError('Delivery content exceeds the bounded evidence snapshot contract.');
  }
  const candidates: DeliveryToolEvidenceSnapshot[] = [];
  const candidateByInvocation = new Map<string, number>();
  let revision = 0;
  for (const event of [...input.events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== 'tool.observed' && event.type !== 'tool.outcome_resolved') continue;
    revision += 1;
    if (event.type === 'tool.observed') {
      if (event.payload.outcome !== 'succeeded') continue;
      const candidate = deliveryToolEvidence({
        evidenceRevision: revision,
        observationId: event.payload.observationId,
        invocationId: event.payload.invocationId,
        summary: event.payload.summary,
        evidenceRefs: event.payload.evidenceRefs,
        completionEvidence: event.payload.completionEvidence,
        modelProjection: event.payload.modelProjection,
      });
      candidateByInvocation.set(candidate.invocationId, candidates.length);
      candidates.push(candidate);
      continue;
    }
    if (event.payload.outcome !== 'succeeded') continue;
    const priorIndex = candidateByInvocation.get(event.payload.invocationId);
    const prior = priorIndex === undefined ? undefined : candidates[priorIndex];
    const candidate = deliveryToolEvidence({
      evidenceRevision: revision,
      observationId: prior?.observationId ?? `resolution:${event.payload.resolutionId}`,
      invocationId: event.payload.invocationId,
      summary: event.payload.summary,
      evidenceRefs: event.payload.evidenceRefs,
      completionEvidence: event.payload.completionEvidence,
      modelProjection: event.payload.modelProjection,
    });
    if (priorIndex === undefined) {
      candidateByInvocation.set(candidate.invocationId, candidates.length);
      candidates.push(candidate);
    } else {
      candidates[priorIndex] = candidate;
    }
  }
  if (revision !== input.evidenceRevision) {
    throw new TypeError(
      `Delivery evidence revision mismatch: projected ${revision}, expected ${input.evidenceRevision}.`,
    );
  }
  const newestFirst = [...candidates]
    .sort((left, right) => right.evidenceRevision - left.evidenceRevision);
  const selected = newestFirst.find((candidate) =>
    candidate.completionEvidence?.deliveryReady === true &&
    candidate.completionEvidence.outcome !== 'failed' &&
    candidate.completionEvidence.outcome !== 'cancelled') ??
    newestFirst.find((candidate) =>
      candidate.evidenceRefs.length > 0 || candidate.completionEvidence !== undefined);
  const toolEvidence = selected === undefined ? [] : [selected];
  const selection: DeliveryEvidenceSelection = selected === undefined
    ? 'none'
    : selected.completionEvidence?.deliveryReady === true
      ? 'latest-delivery-ready'
      : 'latest-observation';
  return Object.freeze({
    schemaVersion: 2,
    revision: input.evidenceRevision,
    finalContentRef: input.finalContentRef,
    finalText: input.finalText,
    finalTextDigest: `sha256:${createHash('sha256').update(input.finalText).digest('hex')}`,
    evidenceRefs: Object.freeze(selected === undefined ? [] : [...selected.evidenceRefs]),
    selection,
    toolEvidence: Object.freeze(toolEvidence),
  });
}

/**
 * Rejects only an exact protocol envelope. Embedded examples remain ordinary
 * text and are never interpreted as executable actions.
 */
export function isDeliverableFinalText(value: string): boolean {
  const text = value.trim();
  return text !== '' && !isExactToolProtocolEnvelope(text);
}

/**
 * Detects an explicit promise to perform a concrete next action after the
 * Model has already stopped. This is deliberately narrow: ordinary plans,
 * recommendations and completed-work summaries remain valid final answers.
 */
export function isPendingActionFinalText(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  const englishLead = String.raw`(?:let me|i(?:'ll| will| am going to)|next[, ]+i(?:'ll| will)|now[, ]+i(?:'ll| will))(?!\s+not\b)`;
  const action = String.raw`(?:run|execute|verify|check|test|stage|commit|create|write|edit|fix|query|search|inspect|read|get|fetch|gather|load|examine|sample|analy[sz]e|explore|investigate|review|calculate|compute|prepare|summari[sz]e|understand|materiali[sz]e|save|export|open|click|navigate|install|build|deploy|continue)`;
  const pagedProgressNote = /\b(?:page|batch|step)\s+\d+\s+(?:is\s+)?(?:done|completed)\b[\s\S]{0,120}?[.!?]\s*(?:continue|proceed)\s+(?:to|with)\s+(?:the\s+)?(?:next|page|batch|step)\b/iu;
  return new RegExp(`${englishLead}.{0,120}\\b${action}\\b`, 'iu').test(text) ||
    pagedProgressNote.test(text) ||
    /(?:让我|我来|接下来|下一步|现在我会|我将)(?!不).{0,80}(?:运行|执行|验证|检查|测试|暂存|提交|创建|写入|编辑|修复|查询|搜索|读取|打开|点击|导航|安装|构建|部署|继续)/u.test(text);
}

function deliveryToolEvidence(input: Readonly<{
  evidenceRevision: number;
  observationId: string;
  invocationId: string;
  summary: string;
  evidenceRefs: readonly string[];
  completionEvidence?: DeliveryToolEvidenceSnapshot['completionEvidence'];
  modelProjection?: DeliveryToolEvidenceSnapshot['modelProjection'];
}>): DeliveryToolEvidenceSnapshot {
  return Object.freeze({
    evidenceRevision: input.evidenceRevision,
    observationId: input.observationId,
    invocationId: input.invocationId,
    summary: input.summary,
    evidenceRefs: Object.freeze(normalizeAgentEvidenceRefs(input.evidenceRefs)),
    ...(input.completionEvidence === undefined
      ? {}
      : { completionEvidence: structuredClone(input.completionEvidence) }),
    ...(input.modelProjection === undefined
      ? {}
      : { modelProjection: structuredClone(input.modelProjection) }),
  });
}

function isExactToolProtocolEnvelope(text: string): boolean {
  const tag = 'tool_calls';
  const openingPrefix = `<${tag}`;
  if (!text.startsWith(openingPrefix)) return false;
  const boundary = text[openingPrefix.length];
  if (boundary !== '>' && boundary !== '/' && !isXmlWhitespace(boundary)) return false;
  const openingEnd = findTagEnd(text, openingPrefix.length);
  if (openingEnd < 0) return false;
  if (text[openingEnd - 1] === '/') return text.slice(openingEnd + 1).trim() === '';
  const closing = `</${tag}>`;
  const closingStart = text.lastIndexOf(closing);
  return closingStart > openingEnd && text.slice(closingStart + closing.length).trim() === '';
}

function findTagEnd(text: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

function isXmlWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r';
}
