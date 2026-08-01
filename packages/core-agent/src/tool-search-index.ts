import type { AgentToolDescriptor } from './types.js';

export type ToolSearchOptions = {
  limit?: number;
  allowedTools?: readonly string[];
};

export type ToolSearchMatch = {
  tool: AgentToolDescriptor;
  score: number;
  matchedTerms: string[];
};

export interface ToolSearchIndex {
  search(query: string, options?: ToolSearchOptions): ToolSearchMatch[];
}

type IndexedTool = {
  tool: AgentToolDescriptor;
  terms: Map<string, number>;
  length: number;
};

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Small Provider-independent BM25 index with CJK bigram/unigram tokenization.
 * It deliberately has no model or embedding dependency, so discovery works
 * with official providers, proxies and local models in the same way.
 */
export class LexicalToolSearchIndex implements ToolSearchIndex {
  private readonly documents: IndexedTool[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(tools: readonly AgentToolDescriptor[]) {
    this.documents = tools.map((tool) => indexTool(tool));
    for (const document of this.documents) {
      for (const term of document.terms.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.averageLength =
      this.documents.length === 0
        ? 1
        : this.documents.reduce((sum, document) => sum + document.length, 0) /
          this.documents.length;
  }

  search(query: string, options: ToolSearchOptions = {}): ToolSearchMatch[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || this.documents.length === 0) return [];
    const allowed =
      options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
    const limit = Math.max(1, Math.min(options.limit ?? 8, 100));

    return this.documents
      .filter((document) => allowed === undefined || allowed.has(document.tool.flatName))
      .map((document) => scoreDocument(document, queryTerms, this))
      .filter((match) => match.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.tool.flatName.localeCompare(right.tool.flatName),
      )
      .slice(0, limit);
  }

  idf(term: string): number {
    const frequency = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (this.documents.length - frequency + 0.5) / (frequency + 0.5));
  }

  lengthNormalization(documentLength: number): number {
    return 1 - BM25_B + BM25_B * (documentLength / this.averageLength);
  }
}

function scoreDocument(
  document: IndexedTool,
  queryTerms: readonly string[],
  index: LexicalToolSearchIndex,
): ToolSearchMatch {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of queryTerms) {
    const frequency = document.terms.get(term) ?? 0;
    if (frequency <= 0) continue;
    matchedTerms.push(term);
    score +=
      index.idf(term) *
      ((frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * index.lengthNormalization(document.length)));
  }
  return { tool: document.tool, score, matchedTerms };
}

function indexTool(tool: AgentToolDescriptor): IndexedTool {
  const terms = new Map<string, number>();
  addWeighted(terms, tool.flatName, 7);
  addWeighted(terms, tool.id.name, 7);
  addWeighted(terms, tool.id.namespace ?? '', 4);
  addWeighted(terms, tool.title ?? '', 6);
  addWeighted(terms, tool.aliases.join(' '), 6);
  addWeighted(terms, tool.tags.join(' '), 5);
  addWeighted(terms, schemaSearchText(tool.inputSchema), 4);
  addWeighted(terms, tool.description, 2);
  addWeighted(terms, `${tool.source} ${tool.sourceId ?? ''}`, 1);
  const length = [...terms.values()].reduce((sum, value) => sum + value, 0) || 1;
  return { tool, terms, length };
}

function addWeighted(target: Map<string, number>, value: string, weight: number): void {
  for (const token of tokenize(value)) {
    target.set(token, (target.get(token) ?? 0) + weight);
  }
}

function schemaSearchText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => schemaSearchText(item, depth + 1)).join(' ');
  if (typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => [key, schemaSearchText(item, depth + 1)])
    .join(' ');
}

export function tokenizeToolSearchText(value: string): string[] {
  return tokenize(value);
}

function tokenize(value: string): string[] {
  const prepared = value
    .normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/[_./:\\-]+/g, ' ')
    .toLocaleLowerCase();
  const segments = prepared.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      tokens.push(...characters);
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`);
      }
      if (characters.length <= 8) tokens.push(segment);
    } else {
      tokens.push(...latinTokenVariants(segment));
    }
  }
  return tokens.filter(Boolean);
}

function latinTokenVariants(segment: string): string[] {
  const variants = new Set([segment]);
  if (segment.length > 4 && segment.endsWith('ies')) {
    variants.add(`${segment.slice(0, -3)}y`);
  } else if (
    segment.length > 4 &&
    /(?:ches|shes|ses|xes|zes)$/u.test(segment)
  ) {
    variants.add(segment.slice(0, -2));
  } else if (segment.length > 3 && segment.endsWith('s') && !segment.endsWith('ss')) {
    variants.add(segment.slice(0, -1));
  }

  // A namespaced prefix token connects common derivations such as
  // relation/related/relationships without a central, domain-specific synonym table.
  if (segment.length >= 6) variants.add(`^${segment.slice(0, 5)}`);
  return [...variants];
}
