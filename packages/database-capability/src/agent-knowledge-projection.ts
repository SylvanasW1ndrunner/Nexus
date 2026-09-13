import type {
  BusinessKnowledgeItem,
  KnowledgeCatalog,
  KnowledgeCatalogNode,
  SchemaRagSearchResult,
} from '@dbagent/core-rag';
import type { ResourceRelation } from '@dbagent/shared';

const TOOL_HIDDEN_FACT_KEYS = new Set([
  'referencedTableNativeId',
  'parentNativeId',
]);

/**
 * Boundary between the internal knowledge catalog and model-visible tool results.
 *
 * The catalog deliberately contains opaque ids, Merkle hashes, graph indexes and
 * version metadata. None of those fields may cross this boundary.
 */
export type AgentResourceSummary = {
  kind: string;
  name: string;
  displayName: string;
};

export type AgentResourceDetail = {
  resource: AgentResourceSummary & { facts: unknown };
  columns: Array<AgentResourceSummary & { facts: unknown }>;
  constraints: Array<AgentResourceSummary & { facts: unknown }>;
  indexes: Array<AgentResourceSummary & { facts: unknown }>;
  otherResources: Array<AgentResourceSummary & { facts: unknown }>;
  relations: Array<{
    kind: string;
    direction: 'outgoing' | 'incoming';
    related: AgentResourceSummary;
  }>;
  businessKnowledge: Array<{
    title: string;
    content: string;
    tags: string[];
  }>;
};

export function resolveAgentResourceReference(
  catalog: KnowledgeCatalog,
  reference: string,
): string {
  const normalized = reference.trim().toLocaleLowerCase();
  const candidates = Object.values(catalog.nodes).filter((node) =>
    semanticReferences(catalog, node).some(
      (candidate) => candidate.toLocaleLowerCase() === normalized,
    ),
  );
  if (candidates.length === 1) return candidates[0]!.resourceId;
  const visibleCandidates = candidates.filter((node) => node.kind !== 'connection');
  if (visibleCandidates.length === 1) return visibleCandidates[0]!.resourceId;
  if (candidates.length > 1) {
    const visibleReferences = [
      ...new Set(candidates.map((node) => agentResourceReference(catalog, node))),
    ];
    throw new Error(
      `Database resource reference is ambiguous: ${reference}. Candidates: ${visibleReferences
        .slice(0, 10)
        .join(', ')}`,
    );
  }
  throw new Error(`Database resource is not available: ${reference}`);
}

export function projectResourceSummary(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): AgentResourceSummary {
  return {
    kind: node.kind,
    name: agentResourceReference(catalog, node),
    displayName: node.displayName,
  };
}

export function projectResourceDetail(
  catalog: KnowledgeCatalog,
  input: {
    node: KnowledgeCatalogNode;
    relations: ResourceRelation[];
    knowledge: BusinessKnowledgeItem[];
  },
): AgentResourceDetail {
  const node = input.node;
  const children = node.childIds
    .map((id) => catalog.nodes[id])
    .filter((child): child is KnowledgeCatalogNode => child !== undefined)
    .filter((child) => child.kind !== 'grant')
    .sort(compareResourceMembers);
  return {
    resource: projectDetailedResource(catalog, node),
    columns: children
      .filter((child) => child.kind === 'column')
      .map((child) => projectDetailedResource(catalog, child)),
    constraints: children
      .filter((child) => child.kind === 'constraint')
      .map((child) => projectDetailedResource(catalog, child)),
    indexes: children
      .filter((child) => child.kind === 'index')
      .map((child) => projectDetailedResource(catalog, child)),
    otherResources: children
      .filter(
        (child) =>
          child.kind !== 'column' &&
          child.kind !== 'constraint' &&
          child.kind !== 'index',
      )
      .map((child) => projectDetailedResource(catalog, child)),
    relations: input.relations
      .filter((relation) => relation.kind !== 'contains')
      .flatMap((relation) => {
        const direction =
          relation.fromResourceId === node.resourceId ? 'outgoing' : 'incoming';
        const relatedResourceId =
          direction === 'outgoing'
            ? relation.toResourceId
            : relation.fromResourceId;
        const related = catalog.nodes[relatedResourceId];
        if (!related) return [];
        return [
          {
            kind: relation.kind,
            direction,
            related: projectResourceSummary(catalog, related),
          },
        ];
      }),
    businessKnowledge: input.knowledge.map((item) => ({
      title: item.title,
      content: compactText(item.content, 2_000),
      tags: [...item.tags],
    })),
  };
}

export function projectKnowledgeSearchResult(
  result: SchemaRagSearchResult,
): {
  document: {
    kind: string;
    schema?: string;
    table?: string;
    column?: string;
    title: string;
    text: string;
  };
} {
  const document = result.document;
  return {
    document: {
      kind: document.kind,
      ...(document.schema ? { schema: document.schema } : {}),
      ...(document.table ? { table: document.table } : {}),
      ...(document.column === undefined ? {} : { column: document.column }),
      title: semanticDocumentTitle(document),
      text: compactText(semanticDocumentText(document.text), 3_000),
    },
  };
}

function projectDetailedResource(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): AgentResourceSummary & { facts: unknown } {
  return {
    ...projectResourceSummary(catalog, node),
    facts: compactUnknown(
      {
        ...(isPlainRecord(node.localFacts.attributes)
          ? node.localFacts.attributes
          : {}),
        ...(isPlainRecord(node.localFacts.facts) ? node.localFacts.facts : {}),
      },
      0,
    ),
  };
}

function semanticReferences(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): string[] {
  return [
    agentResourceReference(catalog, node),
    node.canonicalName,
    node.displayName,
  ]
    .map((candidate) => candidate.trim())
    .filter(Boolean);
}

function agentResourceReference(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): string {
  const databaseObject = databaseObjectReference(catalog, node);
  if (databaseObject) return databaseObject;
  const semanticName = node.canonicalName || node.displayName;
  const normalized = semanticName.trim().toLocaleLowerCase();
  const collides = Object.values(catalog.nodes).some(
    (candidate) =>
      candidate.resourceId !== node.resourceId &&
      candidate.kind !== 'connection' &&
      (candidate.canonicalName || candidate.displayName)
        .trim()
        .toLocaleLowerCase() === normalized,
  );
  return collides ? `${node.kind}:${semanticName}` : semanticName;
}

function databaseObjectReference(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): string | undefined {
  if (
    ![
      'table',
      'view',
      'materialized-view',
      'external-table',
      'column',
    ].includes(node.kind)
  ) {
    return undefined;
  }
  const chain = [...node.ancestorIds, node.resourceId]
    .map((id) => catalog.nodes[id])
    .filter((candidate): candidate is KnowledgeCatalogNode => candidate !== undefined);
  const schema = chain.find((candidate) => candidate.kind === 'schema');
  const table = [...chain]
    .reverse()
    .find((candidate) =>
      ['table', 'view', 'materialized-view', 'external-table'].includes(candidate.kind),
    );
  const column = node.kind === 'column' ? node : undefined;
  if (!schema || !table) return undefined;
  return [schema.displayName, table.displayName, column?.displayName]
    .filter((part): part is string => part !== undefined)
    .join('.');
}

function semanticDocumentTitle(
  document: SchemaRagSearchResult['document'],
): string {
  if (document.schema && document.table && document.column) {
    return `${document.schema}.${document.table}.${document.column}`;
  }
  if (
    document.schema &&
    document.table &&
    ['table', 'view', 'materialized-view', 'external-table'].includes(document.kind)
  ) {
    return `${document.schema}.${document.table}`;
  }
  const finalSegment = document.title.split(/[\\/]/).filter(Boolean).at(-1);
  if (document.schema && document.table && finalSegment) {
    return `${document.schema}.${document.table}.${finalSegment}`;
  }
  return finalSegment ?? document.title;
}

function semanticDocumentText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('资源:') && !line.startsWith('类型:'))
    .join('\n')
    .trim();
}

function compareResourceMembers(
  left: KnowledgeCatalogNode,
  right: KnowledgeCatalogNode,
): number {
  return (
    resourceMemberRank(left.kind) - resourceMemberRank(right.kind) ||
    left.canonicalName.localeCompare(right.canonicalName)
  );
}

function resourceMemberRank(kind: string): number {
  if (kind === 'column') return 0;
  if (kind === 'constraint') return 1;
  if (kind === 'index') return 2;
  return 3;
}

function compactUnknown(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return compactText(value, 1_500);
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= 4) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => compactUnknown(item, depth + 1));
  }
  if (!isPlainRecord(value)) {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item !== null &&
          item !== undefined &&
          !TOOL_HIDDEN_FACT_KEYS.has(key),
      )
      .slice(0, 100)
      .map(([key, item]) => [key, compactUnknown(item, depth + 1)]),
  );
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
