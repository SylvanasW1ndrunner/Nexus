import { createHash } from 'node:crypto';

export type ToolQuestion = {
  id: string;
  prompt: string;
  options?: { id: string; label: string; description?: string }[];
};
export type ToolQuestionAnswer = { id: string; text?: string; optionId?: string };
export type ToolQuestionBundle = {
  questionId: string;
  questionRevision: 1;
  idempotencyKey: string;
  owner: { hostId: string; projectId: string; sessionId: string; runId: string; turnId: string; invocationId: string };
  questions: ToolQuestion[];
  deadline: string | null;
};

/** Host ingress only. This is intentionally NOT a model RuntimeCommand variant. */
export type QuestionRuntimeCommand = {
  kind: 'question.answer';
  commandId: string;
  questionId: string;
  questionRevision: number;
  answers: ToolQuestionAnswer[];
} | {
  kind: 'question.cancel' | 'question.timeout';
  commandId: string;
  questionId: string;
  questionRevision: number;
  reason?: string;
};

function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new TypeError('Question text is missing or exceeds its bound.');
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Invalid question fields.');
}

export function validateToolQuestions(value: unknown): asserts value is ToolQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new TypeError('Expected one to three questions.');
  const ids = new Set<string>();
  for (const question of value) {
    object(question, ['id', 'prompt', 'options']); text(question.id, 64); text(question.prompt, 512);
    if (ids.has(question.id)) throw new TypeError('Question ids must be unique.');
    ids.add(question.id);
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) throw new TypeError('Expected two or three mutually exclusive options.');
      const optionIds = new Set<string>();
      for (const option of question.options) {
        object(option, ['id', 'label', 'description']); text(option.id, 64); text(option.label, 64);
        if (option.description !== undefined) text(option.description, 256);
        if (optionIds.has(option.id)) throw new TypeError('Option ids must be unique.');
        optionIds.add(option.id);
      }
    }
  }
}

export function validateToolQuestionBundle(value: unknown): asserts value is ToolQuestionBundle {
  object(value, ['questionId', 'questionRevision', 'idempotencyKey', 'owner', 'questions', 'deadline']);
  text(value.questionId, 128); text(value.idempotencyKey, 256);
  if (value.questionRevision !== 1) throw new TypeError('Unsupported question revision.');
  object(value.owner, ['hostId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId']);
  for (const key of ['hostId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId']) text(value.owner[key], 512);
  validateToolQuestions(value.questions);
  if (value.deadline !== null && (typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline)))) throw new TypeError('Invalid question deadline.');
}

export function validateQuestionCommand(value: unknown, bundle: ToolQuestionBundle): asserts value is QuestionRuntimeCommand {
  object(value, ['kind', 'commandId', 'questionId', 'questionRevision', 'answers', 'reason']);
  text(value.commandId, 128);
  if (value.questionId !== bundle.questionId || value.questionRevision !== bundle.questionRevision) throw new TypeError('Question id/revision does not match the pending question.');
  if (value.kind === 'question.answer') {
    if (value.reason !== undefined || !Array.isArray(value.answers) || value.answers.length !== bundle.questions.length) throw new TypeError('Every question requires exactly one bounded answer.');
    const ids = new Set<string>();
    for (const answer of value.answers) {
      object(answer, ['id', 'text', 'optionId']); text(answer.id, 64);
      const question = bundle.questions.find(item => item.id === answer.id);
      if (!question || ids.has(answer.id) || (answer.text === undefined) === (answer.optionId === undefined)) throw new TypeError('Answer must select one option or supply free text.');
      ids.add(answer.id);
      if (answer.text !== undefined) text(answer.text, 512);
      else {
        text(answer.optionId, 64);
        if (!question.options?.some(option => option.id === answer.optionId)) throw new TypeError('Unknown question option.');
      }
    }
    // Guarantees the complete structured answer is representable in the Runtime's inline JSON preview.
    if (Buffer.byteLength(JSON.stringify(value.answers), 'utf8') > 6 * 1024) throw new TypeError('Answers exceed the shared inline result budget.');
  } else if (value.kind === 'question.cancel' || value.kind === 'question.timeout') {
    if (value.answers !== undefined) throw new TypeError('Cancellation cannot carry answers.');
    if (value.reason !== undefined) text(value.reason, 512);
  } else throw new TypeError('Unknown Host question command.');
}

/** Canonical Host command used for both the answer payload and its Journal receipt. */
export function normalizeQuestionCommand(command: QuestionRuntimeCommand, bundle: ToolQuestionBundle): QuestionRuntimeCommand {
  validateQuestionCommand(command, bundle);
  const base = { commandId: command.commandId, questionId: bundle.questionId, questionRevision: bundle.questionRevision };
  if (command.kind !== 'question.answer') return { kind: command.kind, ...base, ...(command.reason === undefined ? {} : { reason: command.reason }) };
  const answersById = new Map(command.answers.map(answer => [answer.id, answer]));
  return {
    kind: 'question.answer', ...base,
    answers: bundle.questions.map(question => {
      const answer = answersById.get(question.id)!;
      // Rebuild objects too: caller property order must not change the JSON preview.
      return { id: question.id, ...(answer.text === undefined ? { optionId: answer.optionId! } : { text: answer.text }) };
    }),
  };
}

export function questionCommandDigest(command: QuestionRuntimeCommand): string {
  // Explicit ordering makes retransmission independent of caller property order.
  return createHash('sha256').update(JSON.stringify({
    kind: command.kind, commandId: command.commandId, questionId: command.questionId,
    questionRevision: command.questionRevision,
    ...(command.kind === 'question.answer' ? { answers: [...command.answers].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(a => ({ id: a.id, text: a.text ?? null, optionId: a.optionId ?? null })) } : { reason: command.reason ?? null }),
  })).digest('hex');
}

const waitRequests = new WeakMap<object, ToolQuestionBundle>();
/** Local opaque result; transport/cloning cannot confer wait authority. */
export function createToolQuestionWaitRequest(bundle: ToolQuestionBundle): object {
  validateToolQuestionBundle(bundle);
  const result = Object.freeze({});
  waitRequests.set(result, structuredClone(bundle));
  return result;
}
export function readToolQuestionWaitRequest(value: unknown): ToolQuestionBundle | undefined {
  const bundle = value !== null && typeof value === 'object' ? waitRequests.get(value) : undefined;
  return bundle === undefined ? undefined : structuredClone(bundle);
}
