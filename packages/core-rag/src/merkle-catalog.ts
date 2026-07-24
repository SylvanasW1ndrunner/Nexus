import { createHash } from 'node:crypto';
import type {
  KnowledgeCatalog,
  KnowledgeCatalogChange,
  KnowledgeCatalogDiff,
  KnowledgeCatalogNode,
} from './types.js';

const CHILD_HASH_BLOCK_SIZE = 128;

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function applyKnowledgeCatalogHashes(
  catalog: Omit<
    KnowledgeCatalog,
    | 'containmentRootHash'
    | 'relationRootHash'
    | 'knowledgeRootHash'
    | 'catalogRootHash'
    | 'snapshotId'
  >,
): KnowledgeCatalog {
  const nodes = structuredClone(catalog.nodes);
  const visiting = new Set<string>();
  const completed = new Set<string>();

  const hashNode = (resourceId: string): string => {
    const node = nodes[resourceId];
    if (!node) throw new Error(`Knowledge catalog child does not exist: ${resourceId}`);
    if (completed.has(resourceId)) return node.subtreeHash;
    if (visiting.has(resourceId)) {
      throw new Error(`Knowledge catalog contains cycle at resource: ${resourceId}`);
    }
    visiting.add(resourceId);

    const childEntries = [...node.childIds]
      .sort()
      .map((childId) => ({ resourceId: childId, subtreeHash: hashNode(childId) }));
    const childBlockHashes: string[] = [];
    for (let offset = 0; offset < childEntries.length; offset += CHILD_HASH_BLOCK_SIZE) {
      childBlockHashes.push(
        hashCanonical(childEntries.slice(offset, offset + CHILD_HASH_BLOCK_SIZE)),
      );
    }
    const localHash = hashCanonical(localNodePayload(node));
    const subtreeHash = hashCanonical({
      localHash,
      childBlockHashes,
      childCount: childEntries.length,
    });
    nodes[resourceId] = {
      ...node,
      localHash,
      childBlockHashes,
      subtreeHash,
    };
    visiting.delete(resourceId);
    completed.add(resourceId);
    return subtreeHash;
  };

  const rootEntries = [...catalog.rootIds]
    .sort()
    .map((resourceId) => ({ resourceId, subtreeHash: hashNode(resourceId) }));
  if (completed.size !== Object.keys(nodes).length) {
    const detached = Object.keys(nodes).filter((id) => !completed.has(id)).sort();
    throw new Error(`Knowledge catalog contains detached resources: ${detached.join(', ')}`);
  }

  const containmentRootHash = hashCanonical(rootEntries);
  const relationRootHash = hashCanonical(
    Object.values(catalog.relations)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((relation) => ({
        id: relation.id,
        kind: relation.kind,
        fromResourceId: relation.fromResourceId,
        toResourceId: relation.toResourceId,
        attributes: relation.attributes ?? {},
        version: relation.version,
        deletedAt: relation.deletedAt ?? null,
      })),
  );
  const knowledgeRootHash = hashCanonical({
    knowledge: Object.values(catalog.knowledge)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        contentHash: item.contentHash,
        title: item.title,
        tags: [...item.tags].sort(),
        source: item.source,
        version: item.version,
      })),
    bindings: Object.values(catalog.bindings)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((binding) => ({
        id: binding.id,
        knowledgeId: binding.knowledgeId,
        resourceId: binding.resourceId,
        mode: binding.mode,
        version: binding.version,
      })),
  });
  const catalogRootHash = hashCanonical({
    version: catalog.version,
    connectionId: catalog.connectionId,
    containmentRootHash,
    relationRootHash,
    knowledgeRootHash,
  });

  return {
    ...catalog,
    nodes,
    containmentRootHash,
    relationRootHash,
    knowledgeRootHash,
    catalogRootHash,
    snapshotId: `knowledge:${catalogRootHash}`,
  };
}

export function verifyKnowledgeCatalog(catalog: KnowledgeCatalog): {
  valid: boolean;
  expectedRootHash: string;
  actualRootHash: string;
} {
  const rebuilt = applyKnowledgeCatalogHashes({
    version: catalog.version,
    connectionId: catalog.connectionId,
    rootIds: catalog.rootIds,
    nodes: catalog.nodes,
    relations: catalog.relations,
    knowledge: catalog.knowledge,
    bindings: catalog.bindings,
    ...(catalog.sourceRevision === undefined
      ? {}
      : { sourceRevision: catalog.sourceRevision }),
    builtAt: catalog.builtAt,
  });
  return {
    valid: rebuilt.catalogRootHash === catalog.catalogRootHash,
    expectedRootHash: rebuilt.catalogRootHash,
    actualRootHash: catalog.catalogRootHash,
  };
}

export function diffKnowledgeCatalogs(
  previous: KnowledgeCatalog,
  next: KnowledgeCatalog,
): KnowledgeCatalogDiff {
  assertSameConnection(previous, next);
  if (previous.catalogRootHash === next.catalogRootHash) {
    return {
      equal: true,
      previousRootHash: previous.catalogRootHash,
      nextRootHash: next.catalogRootHash,
      changedResources: [],
      changedRelationIds: [],
      changedKnowledgeIds: [],
    };
  }

  return {
    equal: false,
    previousRootHash: previous.catalogRootHash,
    nextRootHash: next.catalogRootHash,
    changedResources: diffNodes(previous, next),
    changedRelationIds:
      previous.relationRootHash === next.relationRootHash
        ? []
        : diffHashedRecords(previous.relations, next.relations),
    changedKnowledgeIds: [
      ...(previous.knowledgeRootHash === next.knowledgeRootHash
        ? []
        : [
            ...diffHashedRecords(previous.knowledge, next.knowledge),
            ...diffHashedRecords(previous.bindings, next.bindings).map(
              (id) => `binding:${id}`,
            ),
          ]),
    ].sort(),
  };
}

function localNodePayload(node: KnowledgeCatalogNode): unknown {
  return {
    resourceId: node.resourceId,
    connectionId: node.connectionId,
    kind: node.kind,
    parentId: node.parentId ?? null,
    canonicalName: node.canonicalName,
    displayName: node.displayName,
    localFacts: node.localFacts,
    relationIds: [...node.relationIds].sort(),
    knowledgeBindingIds: [...node.knowledgeBindingIds].sort(),
  };
}

function diffNodes(
  previous: KnowledgeCatalog,
  next: KnowledgeCatalog,
): KnowledgeCatalogChange[] {
  const changes: KnowledgeCatalogChange[] = [];
  const visited = new Set<string>();

  const visit = (resourceId: string): void => {
    if (visited.has(resourceId)) return;
    visited.add(resourceId);
    const before = previous.nodes[resourceId];
    const after = next.nodes[resourceId];
    if (!before) {
      collectSubtreeChanges(next, resourceId, 'added', changes, visited);
      return;
    }
    if (!after) {
      changes.push({ resourceId, kind: 'removed' });
      for (const childId of before.childIds) visit(childId);
      return;
    }
    if (before.subtreeHash === after.subtreeHash) return;
    if (before.localHash !== after.localHash) {
      changes.push({ resourceId, kind: 'changed' });
    }
    const childIds = new Set([...before.childIds, ...after.childIds]);
    for (const childId of [...childIds].sort()) visit(childId);
  };

  const rootIds = new Set([...previous.rootIds, ...next.rootIds]);
  for (const rootId of [...rootIds].sort()) visit(rootId);
  return changes.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function collectSubtreeChanges(
  catalog: KnowledgeCatalog,
  resourceId: string,
  kind: Extract<KnowledgeCatalogChange['kind'], 'added' | 'removed'>,
  changes: KnowledgeCatalogChange[],
  visited: Set<string>,
): void {
  const node = catalog.nodes[resourceId];
  if (!node) return;
  changes.push({ resourceId, kind });
  for (const childId of node.childIds) {
    if (visited.has(childId)) continue;
    visited.add(childId);
    collectSubtreeChanges(catalog, childId, kind, changes, visited);
  }
}

function diffHashedRecords<T>(
  previous: Record<string, T>,
  next: Record<string, T>,
): string[] {
  const changed: string[] = [];
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const id of [...ids].sort()) {
    if (!(id in previous) || !(id in next)) {
      changed.push(id);
      continue;
    }
    if (hashCanonical(previous[id]) !== hashCanonical(next[id])) changed.push(id);
  }
  return changed;
}

function assertSameConnection(
  previous: KnowledgeCatalog,
  next: KnowledgeCatalog,
): void {
  if (previous.connectionId !== next.connectionId) {
    throw new Error('Knowledge catalogs from different connections cannot be compared.');
  }
}

function normalizeCanonicalValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical JSON does not support non-finite numbers.');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) normalized[key] = normalizeCanonicalValue(record[key]);
  }
  return normalized;
}
