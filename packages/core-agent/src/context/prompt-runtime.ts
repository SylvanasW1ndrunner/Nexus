import type {
  CanonicalModelRequest,
  CanonicalModelTool,
  ModelContentBlock,
  ModelMessage,
} from '@dbagent/core-llm';
import { assertNoSecretMaterial } from '@dbagent/shared';

export type PromptSectionSource =
  | 'runtime'
  | 'user'
  | 'project'
  | 'capability'
  | 'skill'
  | 'session'
  | 'run'
  | 'observation';

export type PromptSection = Readonly<{
  id: string;
  source: PromptSectionSource;
  scope: 'static' | 'session' | 'run' | 'turn';
  priority: number;
  revision: string;
  cacheability: 'stable' | 'volatile' | 'never';
  content: readonly ModelContentBlock[];
  tokenEstimate: number;
}>;

export type PromptRuntimeOptions = Readonly<{
  runtimeProtocol: PromptSection;
}>;

export type CompilePromptInput = Readonly<{
  model: string;
  sections: readonly PromptSection[];
  tools: readonly CanonicalModelTool[];
  checkpoint?: Readonly<{ summary: string; coveredSequence: number }>;
  userRoleMode?: 'append' | 'replace';
  generation?: Readonly<{
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stop?: readonly string[];
  }>;
}>;

export type CompiledPrompt = Readonly<{
  messages: readonly ModelMessage[];
  tools: readonly CanonicalModelTool[];
  tokenEstimate: number;
  request: CanonicalModelRequest;
}>;

export type PromptRuntimeErrorCode =
  | 'PROMPT_SECTION_INVALID'
  | 'RUNTIME_PROTOCOL_INVALID'
  | 'DUPLICATE_PROMPT_SECTION';

export class PromptRuntimeError extends Error {
  constructor(readonly code: PromptRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'PromptRuntimeError';
  }
}

const SOURCE_ORDER: Readonly<Record<PromptSectionSource, number>> = Object.freeze({
  runtime: 0,
  user: 1,
  project: 2,
  capability: 3,
  skill: 4,
  session: 5,
  run: 6,
  observation: 7,
});

/** Compiles semantic prompt contributions without exposing section identities. */
export class PromptRuntime {
  readonly #runtimeProtocol: PromptSection;

  constructor(options: PromptRuntimeOptions) {
    validateSection(options.runtimeProtocol);
    if (options.runtimeProtocol.source !== 'runtime' || options.runtimeProtocol.scope !== 'static') {
      throw new PromptRuntimeError(
        'RUNTIME_PROTOCOL_INVALID',
        'The non-bypassable runtime protocol must be a static runtime section.',
      );
    }
    this.#runtimeProtocol = freezeSection(options.runtimeProtocol);
  }

  compile(input: CompilePromptInput): CompiledPrompt {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt model is required.');
    }
    const seen = new Set<string>([this.#runtimeProtocol.id]);
    const sections: PromptSection[] = [this.#runtimeProtocol];
    for (const sourceSection of input.sections) {
      validateSection(sourceSection);
      if (sourceSection.source === 'runtime') {
        throw new PromptRuntimeError(
          'RUNTIME_PROTOCOL_INVALID',
          'Callers cannot append or replace the non-bypassable runtime protocol.',
        );
      }
      if (seen.has(sourceSection.id)) {
        throw new PromptRuntimeError(
          'DUPLICATE_PROMPT_SECTION',
          `Prompt section identity is duplicated: ${sourceSection.id}.`,
        );
      }
      seen.add(sourceSection.id);
      sections.push(freezeSection(sourceSection));
    }
    sections.sort((left, right) =>
      SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] ||
      left.priority - right.priority || left.id.localeCompare(right.id));
    if (input.userRoleMode !== undefined && !['append', 'replace'].includes(input.userRoleMode)) {
      throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'userRoleMode is invalid.');
    }
    const selectedSections = input.userRoleMode === 'replace'
      ? replaceUserRoleSections(sections)
      : sections;

    const messages: ModelMessage[] = [];
    let checkpointInjected = false;
    for (const section of selectedSections) {
      messages.push(deepFreeze({
        role: roleForSection(section.source),
        content: section.content.map(cloneBlock),
      }));
      if (
        section.source === 'session' && input.checkpoint !== undefined &&
        !checkpointInjected
      ) {
        messages.push(checkpointMessage(input.checkpoint.summary));
        checkpointInjected = true;
      }
    }
    if (
      input.checkpoint !== undefined &&
      !checkpointInjected
    ) {
      const insertion = messages.findIndex((_, index) => selectedSections[index]?.source === 'run');
      const checkpoint = checkpointMessage(input.checkpoint.summary);
      if (insertion < 0) messages.push(checkpoint);
      else messages.splice(insertion, 0, checkpoint);
    }

    const tools = deepFreeze(input.tools.map((tool) => structuredClone(tool)));
    const request: CanonicalModelRequest = {
      model: input.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content.map(cloneBlock),
      })),
      ...(tools.length === 0 ? {} : { tools: tools.map((tool) => structuredClone(tool)) }),
      ...(input.generation?.temperature === undefined
        ? {}
        : { temperature: input.generation.temperature }),
      ...(input.generation?.topP === undefined ? {} : { topP: input.generation.topP }),
      ...(input.generation?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.generation.maxOutputTokens }),
      ...(input.generation?.stop === undefined ? {} : { stop: [...input.generation.stop] }),
    };
    const checkpointTokens = input.checkpoint === undefined
      ? 0
      : Math.ceil(input.checkpoint.summary.length / 4);
    return deepFreeze({
      messages,
      tools,
      tokenEstimate: selectedSections.reduce((sum, section) => sum + section.tokenEstimate, 0) +
        checkpointTokens,
      request,
    });
  }
}

function replaceUserRoleSections(sections: readonly PromptSection[]): PromptSection[] {
  const lastUser = [...sections].reverse().find(({ source }) => source === 'user');
  if (lastUser === undefined) return [...sections];
  return sections.filter((section) => section.source !== 'user' || section === lastUser);
}

function validateSection(section: PromptSection): void {
  if (
    section === null || typeof section !== 'object' ||
    typeof section.id !== 'string' || section.id.trim() === '' || section.id.length > 512 ||
    !Object.hasOwn(SOURCE_ORDER, section.source) ||
    !['static', 'session', 'run', 'turn'].includes(section.scope) ||
    !Number.isSafeInteger(section.priority) || section.priority < -10_000 ||
    section.priority > 10_000 ||
    typeof section.revision !== 'string' || section.revision.trim() === '' ||
    section.revision.length > 512 ||
    !['stable', 'volatile', 'never'].includes(section.cacheability) ||
    !Array.isArray(section.content) || section.content.length === 0 ||
    !Number.isSafeInteger(section.tokenEstimate) || section.tokenEstimate < 0
  ) {
    throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt section is malformed.');
  }
  for (const block of section.content) validateSemanticBlock(block);
}

function validateSemanticBlock(block: ModelContentBlock): void {
  if (block === null || typeof block !== 'object') {
    throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt content block is malformed.');
  }
  const blockType = (block as { type?: unknown }).type;
  if (
    blockType === 'tool-call' || blockType === 'tool-result' ||
    blockType === 'provider-opaque' || blockType === 'tool-call-draft'
  ) {
    throw new PromptRuntimeError(
      'PROMPT_SECTION_INVALID',
      'Prompt sections cannot manufacture protocol Tool history.',
    );
  }
  if (block.type === 'text' || block.type === 'reasoning-summary') {
    if (typeof block.text !== 'string' || block.text.length > 256_000) {
      throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt text is unbounded.');
    }
    if (block.type === 'reasoning-summary' && block.derivedFromOpaqueRef !== undefined) {
      throw new PromptRuntimeError(
        'PROMPT_SECTION_INVALID',
        'Semantic prompt sections cannot carry provider opaque references.',
      );
    }
    return;
  }
  if (block.type === 'resource-ref') {
    if (
      typeof block.artifactId !== 'string' || block.artifactId.trim() === '' ||
      typeof block.mediaType !== 'string' || block.mediaType.trim() === '' ||
      !['input', 'output'].includes(block.purpose)
    ) {
      throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt resource reference is malformed.');
    }
    try {
      assertNoSecretMaterial(block);
    } catch {
      throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Prompt sections cannot embed secrets.');
    }
    return;
  }
  throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Unsupported prompt protocol block.');
}

function freezeSection(section: PromptSection): PromptSection {
  return Object.freeze({
    id: section.id,
    source: section.source,
    scope: section.scope,
    priority: section.priority,
    revision: section.revision,
    cacheability: section.cacheability,
    content: Object.freeze(section.content.map(cloneBlock)),
    tokenEstimate: section.tokenEstimate,
  });
}

function roleForSection(source: PromptSectionSource): ModelMessage['role'] {
  return source === 'observation' ? 'user' : source === 'runtime' ? 'system' : 'developer';
}

function checkpointMessage(summary: string): ModelMessage {
  if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 256_000) {
    throw new PromptRuntimeError('PROMPT_SECTION_INVALID', 'Checkpoint summary is malformed.');
  }
  return deepFreeze({
    role: 'developer',
    content: [{ type: 'text' as const, text: summary }],
  });
}

function cloneBlock(block: ModelContentBlock): ModelContentBlock {
  return deepFreeze(structuredClone(block));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
