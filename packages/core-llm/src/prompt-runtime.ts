import { createHash } from 'node:crypto';
import type { LlmMessage } from './types.js';

export type PromptTemplate = {
  id: string;
  version: string;
  template: string;
  requiredVariables: string[];
  role?: LlmMessage['role'];
};

export type RenderedPrompt = {
  templateId: string;
  version: string;
  text: string;
  estimatedTokens: number;
  fingerprint: string;
};

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g;

export class PromptTemplateRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): void {
    if (!template.id.trim() || !template.version.trim()) throw new Error('Prompt id and version are required.');
    const key = templateKey(template.id, template.version);
    if (this.templates.has(key)) throw new Error(`Prompt template already exists: ${key}`);
    const referenced = new Set([...template.template.matchAll(VARIABLE_PATTERN)].map((match) => match[1] as string));
    for (const required of template.requiredVariables) {
      if (!referenced.has(required)) throw new Error(`Required prompt variable is not referenced: ${required}`);
    }
    this.templates.set(key, {
      ...template,
      id: template.id.trim(),
      version: template.version.trim(),
      requiredVariables: [...template.requiredVariables],
    });
  }

  render(id: string, version: string, variables: Record<string, string>): RenderedPrompt {
    const template = this.templates.get(templateKey(id, version));
    if (!template) throw new Error(`Prompt template is not registered: ${id}@${version}`);
    for (const name of template.requiredVariables) {
      if (typeof variables[name] !== 'string') throw new Error(`Prompt variable is required: ${name}`);
    }
    const text = template.template.replace(VARIABLE_PATTERN, (_match, name: string) => variables[name] ?? '');
    if (/\{\{\s*[a-zA-Z][a-zA-Z0-9_.-]*\s*\}\}/.test(text)) {
      throw new Error('Prompt contains unresolved variables.');
    }
    return {
      templateId: template.id,
      version: template.version,
      text,
      estimatedTokens: estimateTokens(text),
      fingerprint: hashText(`${template.id}\0${template.version}\0${text}`),
    };
  }

  get(id: string, version: string): PromptTemplate | undefined {
    const template = this.templates.get(templateKey(id, version));
    return template ? { ...template, requiredVariables: [...template.requiredVariables] } : undefined;
  }

  list(): PromptTemplate[] {
    return [...this.templates.values()].map((template) => ({
      ...template,
      requiredVariables: [...template.requiredVariables],
    }));
  }
}

export type ContextChunk = {
  id: string;
  content: string;
  priority: number;
  required?: boolean;
  untrusted?: boolean;
};

export type ContextBudgetTrace = {
  id: string;
  action: 'kept' | 'truncated' | 'dropped';
  originalTokens: number;
  finalTokens: number;
};

export type ContextBudgetResult = {
  text: string;
  estimatedTokens: number;
  trace: ContextBudgetTrace[];
  truncated: boolean;
};

export type ContextBudgetOptions = {
  maxTokens: number;
  reservedOutputTokens?: number;
  separator?: string;
};

export function buildContextWithinBudget(
  chunks: ContextChunk[],
  options: ContextBudgetOptions,
): ContextBudgetResult {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error('maxTokens must be a positive integer.');
  }
  const available = options.maxTokens - Math.max(0, options.reservedOutputTokens ?? 0);
  if (available <= 0) throw new Error('No input token budget remains after reserving output tokens.');
  const separator = options.separator ?? '\n\n';
  const ordered = chunks
    .map((chunk, index) => ({ ...chunk, index, tokenCount: estimateTokens(wrapChunk(chunk)) }))
    .sort((left, right) => Number(Boolean(right.required)) - Number(Boolean(left.required)) || right.priority - left.priority || left.index - right.index);

  const selected: Array<{ index: number; text: string }> = [];
  const traces = new Map<string, ContextBudgetTrace>();
  let used = 0;
  for (const chunk of ordered) {
    const separatorTokens = selected.length === 0 ? 0 : estimateTokens(separator);
    const remaining = available - used - separatorTokens;
    if (chunk.tokenCount <= remaining) {
      selected.push({ index: chunk.index, text: wrapChunk(chunk) });
      used += separatorTokens + chunk.tokenCount;
      traces.set(chunk.id, {
        id: chunk.id,
        action: 'kept',
        originalTokens: chunk.tokenCount,
        finalTokens: chunk.tokenCount,
      });
      continue;
    }
    if (chunk.required) {
      if (remaining < 8) throw new Error(`Required context does not fit token budget: ${chunk.id}`);
      const text = truncateToEstimatedTokens(wrapChunk(chunk), remaining);
      const finalTokens = estimateTokens(text);
      selected.push({ index: chunk.index, text });
      used += separatorTokens + finalTokens;
      traces.set(chunk.id, {
        id: chunk.id,
        action: 'truncated',
        originalTokens: chunk.tokenCount,
        finalTokens,
      });
      continue;
    }
    traces.set(chunk.id, {
      id: chunk.id,
      action: 'dropped',
      originalTokens: chunk.tokenCount,
      finalTokens: 0,
    });
  }

  selected.sort((left, right) => left.index - right.index);
  const text = selected.map((item) => item.text).join(separator);
  return {
    text,
    estimatedTokens: estimateTokens(text),
    trace: chunks.map((chunk) => traces.get(chunk.id) as ContextBudgetTrace),
    truncated: [...traces.values()].some((trace) => trace.action !== 'kept'),
  };
}

export function wrapUntrustedContent(content: string, source = 'external'): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
  return `<untrusted-content source="${safeSource}">\n${content}\n</untrusted-content>`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let units = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x2e80) units += 2.4;
    else if (/\s/.test(character)) units += 0.25;
    else units += 0.65;
  }
  return Math.max(1, Math.ceil(units));
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => {
    const structuredToolTokens = message.toolCalls?.length
      ? estimateTokens(JSON.stringify(message.toolCalls))
      : 0;
    return total + 4 + estimateTokens(message.content) + structuredToolTokens;
  }, 2);
}

function wrapChunk(chunk: ContextChunk): string {
  return chunk.untrusted ? wrapUntrustedContent(chunk.content, chunk.id) : chunk.content;
}

function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (estimateTokens(`${text.slice(0, midpoint)}\n[truncated]`) <= maxTokens) low = midpoint;
    else high = midpoint - 1;
  }
  return `${text.slice(0, low)}\n[truncated]`;
}

function templateKey(id: string, version: string): string {
  return `${id.trim()}@${version.trim()}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
