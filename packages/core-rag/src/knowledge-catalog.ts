import type {
  PortableValue,
  ResourceDescriptor,
  ResourceKind,
  ResourceRelation,
  ResourceSource,
  TableDetail,
} from '@dbagent/shared';
import { applyKnowledgeCatalogHashes, hashCanonical } from './merkle-catalog.js';
import { tokenize } from './schema-documents.js';
import type {
  BusinessKnowledgeItem,
  KnowledgeBinding,
  KnowledgeCatalog,
  KnowledgeCatalogInput,
  KnowledgeCatalogNode,
  SchemaRagDocument,
} from './types.js';

const SYNTHETIC_ROOT_KIND = 'connection';

export function buildKnowledgeCatalog(input: KnowledgeCatalogInput): KnowledgeCatalog {
  const connectionId = requireValue(input.connectionId, 'connectionId');
  const resources = normalizeResources(input.resources);
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const relations = normalizeRelations(input.relations ?? [], resourceIds);
  const rootResource = createConnectionRoot(connectionId, input.builtAt);
  if (resourceIds.has(rootResource.id)) {
    throw new Error(`Knowledge catalog synthetic root conflicts with resource: ${rootResource.id}`);
  }

  const parentByChild = new Map<string, string>();
  for (const relation of relations) {
    if (relation.kind !== 'contains' || relation.deletedAt) continue;
    const previous = parentByChild.get(relation.toResourceId);
    if (previous && previous !== relation.fromResourceId) {
      throw new Error(
        `Knowledge resource ${relation.toResourceId} has multiple containment parents.`,
      );
    }
    parentByChild.set(relation.toResourceId, relation.fromResourceId);
  }
  for (const resource of resources) {
    const visited = new Set<string>();
    let current: string | undefined = resource.id;
    while (current !== undefined) {
      if (visited.has(current)) {
        throw new Error(`Knowledge catalog contains cycle at resource: ${current}`);
      }
      visited.add(current);
      current = parentByChild.get(current);
    }
  }

  const childrenByParent = new Map<string, string[]>();
  for (const resource of resources) {
    const parentId = parentByChild.get(resource.id) ?? rootResource.id;
    const childIds = childrenByParent.get(parentId) ?? [];
    childIds.push(resource.id);
    childrenByParent.set(parentId, childIds);
  }
  childrenByParent.set(
    rootResource.id,
    [...(childrenByParent.get(rootResource.id) ?? [])].sort(),
  );

  const incidentRelations = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind === 'contains' || relation.deletedAt) continue;
    addMapValue(incidentRelations, relation.fromResourceId, relation.id);
    addMapValue(incidentRelations, relation.toResourceId, relation.id);
  }

  const knowledge = normalizeKnowledge(input.knowledge ?? [], connectionId);
  const bindings = normalizeBindings(
    input.bindings ?? [],
    connectionId,
    new Set(Object.keys(knowledge)),
    new Set([rootResource.id, ...resourceIds]),
  );
  const bindingsByResource = new Map<string, string[]>();
  for (const binding of Object.values(bindings)) {
    addMapValue(bindingsByResource, binding.resourceId, binding.id);
  }

  const descriptors = new Map<string, ResourceDescriptor>([
    [rootResource.id, rootResource],
    ...resources.map((resource) => [resource.id, resource] as const),
  ]);
  const nodes: Record<string, KnowledgeCatalogNode> = {};
  const visiting = new Set<string>();

  const buildNode = (
    resourceId: string,
    parentId: string | undefined,
    ancestors: string[],
    parentPath: string,
  ): void => {
    if (visiting.has(resourceId)) {
      throw new Error(`Knowledge catalog contains cycle at resource: ${resourceId}`);
    }
    const resource = descriptors.get(resourceId);
    if (!resource) throw new Error(`Knowledge catalog resource does not exist: ${resourceId}`);
    visiting.add(resourceId);
    const displayName = resource.displayName?.trim() || resource.canonicalName;
    const path = parentPath ? `${parentPath}/${displayName}` : displayName;
    const childIds = [...(childrenByParent.get(resourceId) ?? [])].sort();
    nodes[resourceId] = {
      resourceId,
      connectionId,
      kind: resource.kind,
      ...(parentId === undefined ? {} : { parentId }),
      canonicalName: resource.canonicalName,
      displayName,
      path,
      ancestorIds: ancestors,
      depth: ancestors.length,
      childIds,
      relationIds: [...(incidentRelations.get(resourceId) ?? [])].sort(),
      knowledgeBindingIds: [...(bindingsByResource.get(resourceId) ?? [])].sort(),
      localFacts: resourceFacts(resource),
      localHash: '',
      childBlockHashes: [],
      subtreeHash: '',
    };
    for (const childId of childIds) {
      buildNode(childId, resourceId, [...ancestors, resourceId], path);
    }
    visiting.delete(resourceId);
  };

  buildNode(rootResource.id, undefined, [], '');
  if (Object.keys(nodes).length !== descriptors.size) {
    const detached = [...descriptors.keys()]
      .filter((resourceId) => nodes[resourceId] === undefined)
      .sort();
    throw new Error(
      `Knowledge catalog contains detached resources: ${detached.join(', ')}`,
    );
  }
  const relationRecord = Object.fromEntries(relations.map((relation) => [relation.id, relation]));
  return applyKnowledgeCatalogHashes({
    version: 1,
    connectionId,
    rootIds: [rootResource.id],
    nodes,
    relations: relationRecord,
    knowledge,
    bindings,
    ...(input.sourceRevision === undefined
      ? {}
      : { sourceRevision: input.sourceRevision }),
    builtAt: input.builtAt ?? new Date().toISOString(),
  });
}

export function buildKnowledgeCatalogFromTables(input: {
  connectionId: string;
  tables: TableDetail[];
  builtAt?: string;
}): KnowledgeCatalog {
  const timestamp = input.builtAt ?? new Date().toISOString();
  const source: ResourceSource = {
    sourceId: `legacy-table-detail:${input.connectionId}`,
    sourceType: 'driver',
    connectionProfileId: input.connectionId,
    observedAt: timestamp,
  };
  const resources: ResourceDescriptor[] = [];
  const relations: ResourceRelation[] = [];
  const databaseId = `database:${input.connectionId}`;
  resources.push(
    legacyResource(databaseId, 'database', input.connectionId, input.connectionId, {}, source),
  );
  const schemaIds = new Set<string>();

  for (const table of input.tables) {
    const schemaId = `schema:${table.schema}`;
    if (!schemaIds.has(schemaId)) {
      schemaIds.add(schemaId);
      resources.push(
        legacyResource(schemaId, 'schema', table.schema, table.schema, {}, source),
      );
      relations.push(legacyContains(databaseId, schemaId, source));
    }
    const tableId = `table:${table.schema}.${table.name}`;
    const tableKind = normalizeTableKind(table.type);
    resources.push(
      legacyResource(
        tableId,
        tableKind,
        `${table.schema}.${table.name}`,
        table.name,
        {
          schema: table.schema,
          table: table.name,
          type: table.type,
          comment: table.comment ?? null,
          rowEstimate: table.rowEstimate ?? null,
          primaryKey: table.primaryKey,
          columnCount: table.columns.length,
          indexes: table.indexes ?? [],
          constraints: table.constraints ?? [],
          viewDefinition: table.viewDefinition ?? null,
        },
        source,
      ),
    );
    relations.push(legacyContains(schemaId, tableId, source));

    for (const column of table.columns) {
      const columnId = `column:${table.schema}.${table.name}.${column.name}`;
      resources.push(
        legacyResource(
          columnId,
          'column',
          `${table.schema}.${table.name}.${column.name}`,
          column.name,
          {
            schema: table.schema,
            table: table.name,
            column: column.name,
            ordinal: column.ordinal,
            dataType: column.dataType,
            nullable: column.nullable,
            defaultValue: column.defaultValue ?? null,
            comment: column.comment ?? null,
            isPrimaryKey: column.isPrimaryKey,
            isIndexed: column.isIndexed,
            isUnique: column.isUnique,
            foreignKey: column.foreignKey ?? null,
          },
          source,
        ),
      );
      relations.push(legacyContains(tableId, columnId, source));
      if (column.foreignKey) {
        const targetTableId = `table:${column.foreignKey.schema}.${column.foreignKey.table}`;
        relations.push(
          legacyRelation(
            'depends_on',
            columnId,
            targetTableId,
            source,
          ),
        );
        relations.push(legacyRelation('depends_on', tableId, targetTableId, source));
      }
    }

    for (const index of table.indexes ?? []) {
      const indexId = `index:${table.schema}.${table.name}.${index.name}`;
      resources.push(
        legacyResource(
          indexId,
          'index',
          `${table.schema}.${table.name}.${index.name}`,
          index.name,
          { ...index },
          source,
        ),
      );
      relations.push(legacyContains(tableId, indexId, source));
    }
    for (const constraint of table.constraints ?? []) {
      const constraintId = `constraint:${table.schema}.${table.name}.${constraint.name}`;
      resources.push(
        legacyResource(
          constraintId,
          'constraint',
          `${table.schema}.${table.name}.${constraint.name}`,
          constraint.name,
          { ...constraint },
          source,
        ),
      );
      relations.push(legacyContains(tableId, constraintId, source));
    }
  }

  const existingIds = new Set(resources.map((resource) => resource.id));
  return buildKnowledgeCatalog({
    connectionId: input.connectionId,
    resources,
    relations: [
      ...new Map(
        relations
          .filter(
            (relation) =>
              existingIds.has(relation.fromResourceId) &&
              existingIds.has(relation.toResourceId),
          )
          .map((relation) => [relation.id, relation]),
      ).values(),
    ],
    builtAt: timestamp,
  });
}

export function buildKnowledgeDocuments(catalog: KnowledgeCatalog): SchemaRagDocument[] {
  const resourceDocumentIds = new Map(
    Object.keys(catalog.nodes).map((resourceId) => [
      resourceId,
      documentIdForResource(catalog.nodes[resourceId]!),
    ]),
  );
  const neighbors = new Map<string, Set<string>>();
  for (const node of Object.values(catalog.nodes)) {
    const documentId = resourceDocumentIds.get(node.resourceId)!;
    for (const childId of node.childIds) {
      connect(neighbors, documentId, resourceDocumentIds.get(childId)!);
    }
    if (node.parentId) {
      connect(neighbors, documentId, resourceDocumentIds.get(node.parentId)!);
    }
  }
  for (const relation of Object.values(catalog.relations)) {
    const from = resourceDocumentIds.get(relation.fromResourceId);
    const to = resourceDocumentIds.get(relation.toResourceId);
    if (from && to) connect(neighbors, from, to);
    if (relation.kind !== 'contains') {
      const fromTable = nearestTableNode(catalog, relation.fromResourceId);
      const toTable = nearestTableNode(catalog, relation.toResourceId);
      if (fromTable && toTable && fromTable.resourceId !== toTable.resourceId) {
        connect(
          neighbors,
          resourceDocumentIds.get(fromTable.resourceId)!,
          resourceDocumentIds.get(toTable.resourceId)!,
        );
      }
    }
  }

  const documents: SchemaRagDocument[] = Object.values(catalog.nodes).map((node) => {
    const location = locateDatabaseObject(catalog, node);
    const inheritedKnowledge = knowledgeForNode(catalog, node);
    const text = nodeDocumentText(node, inheritedKnowledge);
    const title = databaseObjectTitle(node, location);
    return {
      id: resourceDocumentIds.get(node.resourceId)!,
      connectionId: catalog.connectionId,
      kind: node.kind,
      resourceId: node.resourceId,
      schema: location.schema ?? '',
      table: location.table ?? '',
      ...(location.column === undefined ? {} : { column: location.column }),
      title,
      text,
      tokens: tokenize([
        node.canonicalName,
        node.displayName,
        title,
        node.path,
        text,
        ...inheritedKnowledge.flatMap((item) => [item.title, item.content, ...item.tags]),
      ]),
      relationIds: [...(neighbors.get(resourceDocumentIds.get(node.resourceId)!) ?? [])].sort(),
      metadata: {
        ...node.localFacts,
        ...(isRecord(node.localFacts.attributes)
          ? node.localFacts.attributes
          : {}),
        resourceId: node.resourceId,
        parentId: node.parentId ?? null,
        depth: node.depth,
        localHash: node.localHash,
        subtreeHash: node.subtreeHash,
        knowledgeIds: inheritedKnowledge.map((item) => item.id),
      },
    };
  });

  for (const item of Object.values(catalog.knowledge)) {
    const bindingResourceIds = Object.values(catalog.bindings)
      .filter((binding) => binding.knowledgeId === item.id)
      .map((binding) => binding.resourceId);
    const relationIds = bindingResourceIds
      .map((resourceId) => resourceDocumentIds.get(resourceId))
      .filter((id): id is string => id !== undefined);
    documents.push({
      id: `knowledge:${item.id}`,
      connectionId: catalog.connectionId,
      kind: 'knowledge',
      schema: '',
      table: '',
      title: item.title,
      text: item.content,
      tokens: tokenize([item.title, item.content, ...item.tags]),
      relationIds,
      metadata: {
        knowledgeId: item.id,
        contentHash: item.contentHash,
        source: item.source,
        version: item.version,
        tags: item.tags,
      },
    });
  }

  return documents.sort((left, right) => left.id.localeCompare(right.id));
}

function databaseObjectTitle(
  node: KnowledgeCatalogNode,
  location: { schema?: string; table?: string; column?: string },
): string {
  if (location.schema && location.table && location.column) {
    return `${location.schema}.${location.table}.${location.column}`;
  }
  if (
    location.schema &&
    location.table &&
    ['table', 'view', 'materialized-view', 'external-table'].includes(node.kind)
  ) {
    return `${location.schema}.${location.table}`;
  }
  return node.path;
}

export function documentIdForResource(node: KnowledgeCatalogNode): string {
  if (
    node.resourceId.startsWith('table:') ||
    node.resourceId.startsWith('column:')
  ) {
    return node.resourceId;
  }
  return `resource:${node.resourceId}`;
}

function normalizeResources(resources: ResourceDescriptor[]): ResourceDescriptor[] {
  const active = resources.filter((resource) => !resource.deletedAt);
  const ids = new Set<string>();
  return active
    .map((resource) => {
      if (!resource.id.trim()) throw new Error('Knowledge resource id is required.');
      if (ids.has(resource.id)) throw new Error(`Duplicate knowledge resource: ${resource.id}`);
      ids.add(resource.id);
      return structuredClone(resource);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRelations(
  relations: ResourceRelation[],
  resourceIds: Set<string>,
): ResourceRelation[] {
  const ids = new Set<string>();
  return relations
    .filter((relation) => !relation.deletedAt)
    .map((relation) => {
      if (ids.has(relation.id)) throw new Error(`Duplicate knowledge relation: ${relation.id}`);
      ids.add(relation.id);
      if (
        !resourceIds.has(relation.fromResourceId) ||
        !resourceIds.has(relation.toResourceId)
      ) {
        throw new Error(`Knowledge relation ${relation.id} references an unknown resource.`);
      }
      return structuredClone(relation);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeKnowledge(
  items: KnowledgeCatalogInput['knowledge'],
  connectionId: string,
): Record<string, BusinessKnowledgeItem> {
  const result: Record<string, BusinessKnowledgeItem> = {};
  for (const item of items ?? []) {
    const id = requireValue(item.id, 'knowledge.id');
    if (result[id]) throw new Error(`Duplicate business knowledge item: ${id}`);
    const title = requireValue(item.title, `knowledge.${id}.title`);
    const content = requireValue(item.content, `knowledge.${id}.content`);
    result[id] = {
      id,
      connectionId,
      title,
      content,
      contentHash: hashCanonical(content),
      tags: [...new Set((item.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort(),
      source: structuredClone(item.source),
      version: item.version,
      updatedAt: item.updatedAt,
    };
  }
  return result;
}

function normalizeBindings(
  inputs: KnowledgeCatalogInput['bindings'],
  connectionId: string,
  knowledgeIds: Set<string>,
  resourceIds: Set<string>,
): Record<string, KnowledgeBinding> {
  const result: Record<string, KnowledgeBinding> = {};
  for (const binding of inputs ?? []) {
    if (result[binding.id]) throw new Error(`Duplicate knowledge binding: ${binding.id}`);
    if (!knowledgeIds.has(binding.knowledgeId)) {
      throw new Error(`Knowledge binding ${binding.id} references unknown knowledge.`);
    }
    if (!resourceIds.has(binding.resourceId)) {
      throw new Error(`Knowledge binding ${binding.id} references unknown resource.`);
    }
    result[binding.id] = { ...structuredClone(binding), connectionId };
  }
  return result;
}

function createConnectionRoot(
  connectionId: string,
  builtAt = new Date().toISOString(),
): ResourceDescriptor {
  const id = `connection:${hashCanonical(connectionId).slice(0, 24)}`;
  return {
    id,
    kind: SYNTHETIC_ROOT_KIND,
    nativeId: connectionId,
    canonicalName: connectionId,
    displayName: connectionId,
    attributes: { synthetic: true },
    version: 1,
    firstSeenAt: builtAt,
    updatedAt: builtAt,
    sources: [
      {
        sourceId: `knowledge-catalog:${connectionId}`,
        sourceType: 'manual',
        connectionProfileId: connectionId,
        observedAt: builtAt,
      },
    ],
  };
}

function resourceFacts(resource: ResourceDescriptor): Record<string, unknown> {
  return {
    nativeId: resource.nativeId,
    engine: resource.engine ?? null,
    engineVersion: resource.engineVersion ?? null,
    aliases: [...(resource.aliases ?? [])].sort(),
    tags: resource.tags ?? {},
    attributes: resource.attributes ?? {},
    facts: resource.facts ?? {},
    version: resource.version,
    deletedAt: resource.deletedAt ?? null,
  };
}

function locateDatabaseObject(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): { schema?: string; table?: string; column?: string } {
  const chain = [...node.ancestorIds, node.resourceId]
    .map((id) => catalog.nodes[id])
    .filter((item): item is KnowledgeCatalogNode => item !== undefined);
  const schema = chain.find((item) => item.kind === 'schema');
  const table = [...chain]
    .reverse()
    .find((item) =>
      ['table', 'view', 'materialized-view', 'external-table'].includes(item.kind),
    );
  const column = node.kind === 'column' ? node : undefined;
  return {
    ...(schema ? { schema: schema.displayName } : {}),
    ...(table ? { table: table.displayName } : {}),
    ...(column ? { column: column.displayName } : {}),
  };
}

function nearestTableNode(
  catalog: KnowledgeCatalog,
  resourceId: string,
): KnowledgeCatalogNode | undefined {
  const node = catalog.nodes[resourceId];
  if (!node) return undefined;
  return [...node.ancestorIds, node.resourceId]
    .reverse()
    .map((id) => catalog.nodes[id])
    .find(
      (candidate) =>
        candidate !== undefined &&
        ['table', 'view', 'materialized-view', 'external-table'].includes(candidate.kind),
    );
}

function knowledgeForNode(
  catalog: KnowledgeCatalog,
  node: KnowledgeCatalogNode,
): BusinessKnowledgeItem[] {
  const applicableResourceIds = new Set([node.resourceId, ...node.ancestorIds]);
  const ids = new Set<string>();
  for (const binding of Object.values(catalog.bindings)) {
    if (binding.resourceId === node.resourceId || (
      binding.mode === 'subtree' && applicableResourceIds.has(binding.resourceId)
    )) {
      ids.add(binding.knowledgeId);
    }
  }
  return [...ids]
    .map((id) => catalog.knowledge[id])
    .filter((item): item is BusinessKnowledgeItem => item !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function nodeDocumentText(
  node: KnowledgeCatalogNode,
  knowledge: BusinessKnowledgeItem[],
): string {
  const facts = summarizeNodeFacts(node.localFacts);
  return [
    `资源: ${node.path}`,
    `类型: ${node.kind}`,
    facts ? `事实: ${facts}` : undefined,
    ...knowledge.map((item) => `业务知识[${item.title}]: ${item.content}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function summarizeNodeFacts(localFacts: Record<string, unknown>): string {
  const attributes = isRecord(localFacts.attributes)
    ? localFacts.attributes
    : {};
  const parts: string[] = [];
  for (const key of [
    'comment',
    'dataType',
    'nullable',
    'defaultValue',
    'rowEstimate',
    'primaryKey',
    'viewDefinition',
    'definition',
  ]) {
    const value = attributes[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${compactValue(value)}`);
  }
  const indexes = Array.isArray(attributes.indexes) ? attributes.indexes : [];
  if (indexes.length > 0) {
    parts.push(
      `indexes=${indexes
        .map((item) => isRecord(item) ? item.name : undefined)
        .filter(Boolean)
        .join(',')}`,
    );
  }
  const constraints = Array.isArray(attributes.constraints)
    ? attributes.constraints
    : [];
  if (constraints.length > 0) {
    parts.push(
      `constraints=${constraints
        .map((item) => isRecord(item) ? item.name : undefined)
        .filter(Boolean)
        .join(',')}`,
    );
  }
  if (parts.length > 0) return parts.join('; ');
  return flattenFacts(attributes);
}

function compactValue(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map(safeValueText).join(',')
    : typeof value === 'object'
      ? (JSON.stringify(value) ?? '')
      : safeValueText(value);
  return text.length <= 500 ? text : `${text.slice(0, 485)}...[truncated]`;
}

function flattenFacts(value: unknown, prefix = ''): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return `${prefix}${safeValueText(value)}`;
  if (Array.isArray(value)) {
    return value
      .map((item, index) => flattenFacts(item, `${prefix}${index}=`))
      .filter(Boolean)
      .join(', ');
  }
  return Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => flattenFacts(item, `${prefix}${key}=`))
    .filter(Boolean)
    .join(', ');
}

function safeValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return value.name || '[function]';
  if (value === null || value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

function legacyResource(
  id: string,
  kind: ResourceKind,
  nativeId: string,
  displayName: string,
  attributes: Record<string, PortableValue | undefined>,
  source: ResourceSource,
): ResourceDescriptor {
  const cleanedAttributes = Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, PortableValue] => entry[1] !== undefined),
  );
  return {
    id,
    kind,
    nativeId,
    canonicalName: nativeId,
    displayName,
    attributes: cleanedAttributes,
    version: 1,
    firstSeenAt: source.observedAt,
    updatedAt: source.observedAt,
    sources: [source],
  };
}

function legacyContains(
  fromResourceId: string,
  toResourceId: string,
  source: ResourceSource,
): ResourceRelation {
  return legacyRelation('contains', fromResourceId, toResourceId, source);
}

function legacyRelation(
  kind: string,
  fromResourceId: string,
  toResourceId: string,
  source: ResourceSource,
): ResourceRelation {
  return {
    id: `relation:${hashCanonical({ kind, fromResourceId, toResourceId }).slice(0, 32)}`,
    kind,
    fromResourceId,
    toResourceId,
    version: 1,
    firstSeenAt: source.observedAt,
    updatedAt: source.observedAt,
    sources: [source],
  };
}

function normalizeTableKind(type: TableDetail['type']): ResourceKind {
  if (type === 'view') return 'view';
  return 'table';
}

function connect(graph: Map<string, Set<string>>, left: string, right: string): void {
  if (!left || !right || left === right) return;
  const leftValues = graph.get(left) ?? new Set<string>();
  leftValues.add(right);
  graph.set(left, leftValues);
  const rightValues = graph.get(right) ?? new Set<string>();
  rightValues.add(left);
  graph.set(right, rightValues);
}

function addMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function requireValue(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
