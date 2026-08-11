import type {
  CanonicalModelRequest,
  ModelAttemptExecution,
  ModelAttemptOptions,
  ModelContentBlock,
  ModelMessage,
  ModelSession,
  ModelSessionBundle,
} from '@dbagent/core-llm';

export type ContextDecisionInput = Readonly<{
  maxInputTokens: number | null;
  estimatedInputTokens: number;
  outputReserveTokens: number;
  protocolReserveTokens: number;
  toolReserveTokens: number;
  compactedForDecision: boolean;
  manualRequested: boolean;
  safeBoundary: boolean;
}>;

export type ContextLifecycleDecision =
  | Readonly<{
      action: 'use-context';
      diagnostic: 'fits' | 'near-limit' | 'unknown-limit';
      inputBudgetTokens: number | null;
    }>
  | Readonly<{
      action: 'compact'; reason: 'automatic' | 'manual'; inputBudgetTokens: number | null;
    }>
  | Readonly<{ action: 'queue-manual-compaction'; inputBudgetTokens: number | null }>
  | Readonly<{
      action: 'over-limit'; code: 'CONTEXT_STILL_OVER_LIMIT'; inputBudgetTokens: number;
    }>;

export type ContextLifecycleErrorCode =
  | 'CONTEXT_DECISION_INVALID'
  | 'CONTEXT_COMPACTION_FAILED'
  | 'CONTEXT_COMPACTION_EMPTY'
  | 'CONTEXT_HISTORY_INVALID';

export class ContextLifecycleError extends Error {
  constructor(
    readonly code: ContextLifecycleErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ContextLifecycleError';
  }
}

export function decideContextLifecycle(input: ContextDecisionInput): ContextLifecycleDecision {
  validateDecisionInput(input);
  const inputBudgetTokens = input.maxInputTokens === null
    ? null
    : input.maxInputTokens - input.outputReserveTokens -
      input.protocolReserveTokens - input.toolReserveTokens;
  if (inputBudgetTokens !== null && inputBudgetTokens < 1) {
    throw new ContextLifecycleError(
      'CONTEXT_DECISION_INVALID',
      'Model reserves leave no positive input budget.',
    );
  }
  if (input.manualRequested) {
    return input.safeBoundary
      ? { action: 'compact', reason: 'manual', inputBudgetTokens }
      : { action: 'queue-manual-compaction', inputBudgetTokens };
  }
  if (inputBudgetTokens === null) {
    return { action: 'use-context', diagnostic: 'unknown-limit', inputBudgetTokens: null };
  }
  if (input.estimatedInputTokens <= inputBudgetTokens) {
    return {
      action: 'use-context',
      diagnostic: input.estimatedInputTokens >= Math.floor(inputBudgetTokens * 0.9)
        ? 'near-limit'
        : 'fits',
      inputBudgetTokens,
    };
  }
  if (input.compactedForDecision) {
    return { action: 'over-limit', code: 'CONTEXT_STILL_OVER_LIMIT', inputBudgetTokens };
  }
  return { action: 'compact', reason: 'automatic', inputBudgetTokens };
}

type ContextGatewayOptions = ModelAttemptOptions & Readonly<{
  purpose: 'context-compaction';
  toolsEnabled: false;
}>;

export interface ContextModelGateway {
  executeAttempt(
    session: ModelSession | ModelSessionBundle,
    request: CanonicalModelRequest,
    options: ContextGatewayOptions,
  ): Promise<ModelAttemptExecution>;
}

export type ContextLifecycleOptions = Readonly<{
  gateway: ContextModelGateway;
  session: ModelSession | ModelSessionBundle;
}>;

export type CompactContextInput = Readonly<{
  decisionId: string;
  committedThroughSequence: number;
  messages: readonly ModelMessage[];
  signal?: AbortSignal;
}>;

export type ContextCompactionResult = Readonly<{
  status: 'compacted';
  decisionId: string;
  committedThroughSequence: number;
  summary: string;
  attemptId: string;
}>;

/** One compaction call; retry/fallback remains exclusively inside the Gateway. */
export class ContextLifecycle {
  readonly #gateway: ContextModelGateway;
  readonly #session: ModelSession | ModelSessionBundle;

  constructor(options: ContextLifecycleOptions) {
    this.#gateway = options.gateway;
    this.#session = options.session;
  }

  async compact(input: CompactContextInput): Promise<ContextCompactionResult> {
    if (
      typeof input.decisionId !== 'string' || input.decisionId.trim() === '' ||
      !Number.isSafeInteger(input.committedThroughSequence) ||
      input.committedThroughSequence < 0 || !Array.isArray(input.messages)
    ) {
      throw new ContextLifecycleError(
        'CONTEXT_DECISION_INVALID',
        'Compaction decision identity, sequence or committed messages are invalid.',
      );
    }
    const route = 'primary' in this.#session
      ? this.#session.primary.route
      : this.#session.route;
    const request: CanonicalModelRequest = {
      model: route.modelId,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: 'Summarize only the committed semantic history. Preserve decisions, references, constraints and unresolved facts. Do not invent actions.',
          }],
        },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content.map((block: ModelContentBlock) => structuredClone(block)),
        })),
      ],
    };
    let execution: ModelAttemptExecution;
    try {
      execution = await this.#gateway.executeAttempt(this.#session, request, {
        purpose: 'context-compaction',
        toolsEnabled: false,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new ContextLifecycleError(
        'CONTEXT_COMPACTION_FAILED',
        'Context compaction failed without rewriting committed history.',
        error,
      );
    }
    const summary = execution.attempt.blocks
      .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
      .map((block) => block.text)
      .join('')
      .trim();
    if (summary === '') {
      throw new ContextLifecycleError(
        'CONTEXT_COMPACTION_EMPTY',
        'Context compaction returned no committed semantic summary.',
      );
    }
    return Object.freeze({
      status: 'compacted',
      decisionId: input.decisionId,
      committedThroughSequence: input.committedThroughSequence,
      summary,
      attemptId: execution.attempt.attemptId,
    });
  }
}

export type CommittedContextFact = Readonly<{
  sequence: number;
  committed: boolean;
  semantic: string;
}>;

export type ReadCommittedContextPage = (input: Readonly<{
  afterSequence: number;
  throughSequence: number;
  limit: number;
}>) => Promise<readonly CommittedContextFact[]>;

export type BoundedContextReadInput = Readonly<{
  readPage: ReadCommittedContextPage;
  afterSequence: number;
  throughSequence: number;
  pageSize: number;
  maxEvents: number;
}>;

export type BoundedContextReadResult = Readonly<{
  events: readonly CommittedContextFact[];
  nextSequence: number;
  truncated: boolean;
}>;

/** Bounded Run-scoped cursor traversal; it never materializes whole Session history. */
export async function readBoundedCommittedContext(
  input: BoundedContextReadInput,
): Promise<BoundedContextReadResult> {
  if (
    !Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
    !Number.isSafeInteger(input.throughSequence) || input.throughSequence < input.afterSequence ||
    !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000 ||
    !Number.isSafeInteger(input.maxEvents) || input.maxEvents < 1 || input.maxEvents > 10_000
  ) {
    throw new ContextLifecycleError('CONTEXT_HISTORY_INVALID', 'Context cursor bounds are invalid.');
  }
  const events: CommittedContextFact[] = [];
  let cursor = input.afterSequence;
  let scanned = 0;
  while (cursor < input.throughSequence && scanned < input.maxEvents) {
    const limit = Math.min(input.pageSize, input.maxEvents - scanned);
    const page = await input.readPage({
      afterSequence: cursor,
      throughSequence: input.throughSequence,
      limit,
    });
    if (!Array.isArray(page) || page.length > limit) {
      throw new ContextLifecycleError(
        'CONTEXT_HISTORY_INVALID',
        'Context reader returned an invalid or oversized page.',
      );
    }
    if (page.length === 0) break;
    for (const fact of page) {
      if (
        !Number.isSafeInteger(fact.sequence) || fact.sequence <= cursor ||
        fact.sequence > input.throughSequence || typeof fact.committed !== 'boolean' ||
        typeof fact.semantic !== 'string'
      ) {
        throw new ContextLifecycleError(
          'CONTEXT_HISTORY_INVALID',
          'Context reader returned a non-monotonic or malformed fact.',
        );
      }
      cursor = fact.sequence;
      scanned += 1;
      if (fact.committed) events.push(Object.freeze({ ...fact }));
    }
    if (page.length < limit) break;
  }
  return Object.freeze({
    events: Object.freeze(events),
    nextSequence: cursor,
    truncated: cursor < input.throughSequence,
  });
}

function validateDecisionInput(input: ContextDecisionInput): void {
  const values = [
    input.estimatedInputTokens,
    input.outputReserveTokens,
    input.protocolReserveTokens,
    input.toolReserveTokens,
  ];
  if (
    (input.maxInputTokens !== null &&
      (!Number.isSafeInteger(input.maxInputTokens) || input.maxInputTokens < 1)) ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    typeof input.compactedForDecision !== 'boolean' ||
    typeof input.manualRequested !== 'boolean' || typeof input.safeBoundary !== 'boolean'
  ) {
    throw new ContextLifecycleError('CONTEXT_DECISION_INVALID', 'Context decision input is invalid.');
  }
}
