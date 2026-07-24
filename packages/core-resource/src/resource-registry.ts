import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Buffer } from 'node:buffer';
import {
  CURRENT_CONTRACT_VERSION,
  ContractValidationError,
  assertResourceChangeSet,
  assertResourceDescriptor,
  assertResourceObservation,
  assertResourceRegistrySnapshot,
  assertResourceRelation,
  type ObservationStatus,
  type PortableValue,
  type ResolvedResourceFact,
  type ResourceCategoryState,
  type ResourceChangeSet,
  type ResourceDescriptor,
  type ResourceDiscoveryPage,
  type ResourceEvent,
  type ResourceEventPage,
  type ResourceEventQuery,
  type ResourceEventType,
  type ResourceFact,
  type ResourceFreshness,
  type ResourceId,
  type ResourceObservation,
  type ResourceQuery,
  type ResourceQueryPage,
  type ResourceRegistrySnapshot,
  type ResourceRelation,
  type ResourceRelationId,
  type ResourceRelationKind,
  type ResourceScope,
  type ResourceSource,
  type ResourceSourceVersion,
  type ResourceStateSnapshot,
  type ResourceTraversalRequest,
  type ResourceTraversalResult,
} from '@dbagent/shared';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 10_000;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_OBSERVATIONS_PER_RESOURCE = 1_000;
const MAX_TRAVERSAL_DEPTH = 32;
const MAX_TRAVERSAL_RESOURCES = 100_000;

export type ResourceRegistryErrorCode =
  | 'RESOURCE_CONFLICT'
  | 'RESOURCE_VALIDATION_FAILED'
  | 'RELATION_CYCLE'
  | 'STALE_CHANGE_SET'
  | 'INVALID_CURSOR'
  | 'TRAVERSAL_LIMIT_INVALID';

export class ResourceConflictError extends Error {
  constructor(
    message: string,
    readonly code: ResourceRegistryErrorCode = 'RESOURCE_CONFLICT',
  ) {
    super(message);
    this.name = 'ResourceConflictError';
  }
}

export type ResourceRegistryOptions = {
  maxEvents?: number;
  maxObservationsPerResource?: number;
  now?: () => string;
  createEventId?: () => string;
};

export type ResourceChangeResult = {
  upsertedResources: number;
  deletedResources: number;
  restoredResources: number;
  upsertedRelations: number;
  deletedRelations: number;
  observations: number;
  ignored: boolean;
};

export type ResourceDiscoveryResult = {
  resources: number;
  relations: number;
  observations: number;
};

export function createStableResourceId(input: {
  sourceNamespace: string;
  kind: string;
  nativeId: string;
}): ResourceId {
  requireIdentityPart(input.sourceNamespace, 'sourceNamespace');
  requireIdentityPart(input.kind, 'kind');
  requireIdentityPart(input.nativeId, 'nativeId');
  const digest = createHash('sha256')
    .update(`${input.sourceNamespace}\0${input.kind}\0${input.nativeId}`)
    .digest('hex')
    .slice(0, 32);
  return `res_${digest}`;
}

export function createStableRelationId(input: {
  kind: ResourceRelationKind;
  fromResourceId: ResourceId;
  toResourceId: ResourceId;
}): ResourceRelationId {
  requireIdentityPart(input.kind, 'kind');
  requireIdentityPart(input.fromResourceId, 'fromResourceId');
  requireIdentityPart(input.toResourceId, 'toResourceId');
  if (input.fromResourceId === input.toResourceId) {
    throw new ResourceConflictError(
      'Stable relation identity cannot point to itself',
      'RESOURCE_VALIDATION_FAILED',
    );
  }
  const digest = createHash('sha256')
    .update(`${input.kind}\0${input.fromResourceId}\0${input.toResourceId}`)
    .digest('hex')
    .slice(0, 32);
  return `rel_${digest}`;
}

export class ResourceRegistry {
  readonly #resources = new Map<ResourceId, ResourceDescriptor>();
  readonly #relations = new Map<ResourceRelationId, ResourceRelation>();
  readonly #outgoing = new Map<ResourceId, Set<ResourceRelationId>>();
  readonly #incoming = new Map<ResourceId, Set<ResourceRelationId>>();
  readonly #byKind = new Map<string, Set<ResourceId>>();
  readonly #byEngine = new Map<string, Set<ResourceId>>();
  readonly #sortedKindIds = new Map<string, ResourceId[]>();
  readonly #sortedEngineIds = new Map<string, ResourceId[]>();
  readonly #observations = new Map<ResourceId, Map<string, ResourceObservation>>();
  readonly #sourceVersions = new Map<string, ResourceSourceVersion>();
  readonly #events: ResourceEvent[] = [];
  readonly #maxEvents: number;
  readonly #maxObservationsPerResource: number;
  readonly #now: () => string;
  readonly #createEventId: () => string;
  #lastEventSequence = 0;
  #snapshotCreatedAt: string;
  #sortedResourceIds: ResourceId[] | undefined;

  constructor(options: ResourceRegistryOptions = {}) {
    this.#maxEvents = normalizeLimit(
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
      'maxEvents',
    );
    this.#maxObservationsPerResource = normalizeLimit(
      options.maxObservationsPerResource ?? DEFAULT_MAX_OBSERVATIONS_PER_RESOURCE,
      'maxObservationsPerResource',
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createEventId = options.createEventId ?? randomUUID;
    this.#snapshotCreatedAt = requireCanonicalTime(this.#now(), 'now()');
  }

  upsertResource(resource: ResourceDescriptor): ResourceDescriptor {
    validateResourceContract(resource);
    const existing = this.#resources.get(resource.id);
    this.#assertResourceIdentity(existing, resource);
    const merged = existing ? mergeResource(existing, resource) : cloneResource(resource);
    if (existing && isDeepStrictEqual(existing, merged)) {
      return cloneResource(existing);
    }
    if (existing) this.#removeResourceIndexes(existing);
    this.#resources.set(merged.id, merged);
    this.#addResourceIndexes(merged);
    const occurredAt = laterTime(merged.updatedAt, this.#snapshotCreatedAt);
    this.#touchSnapshot(occurredAt);
    this.#recordEvent({
      type: existing ? 'resource-updated' : 'resource-created',
      occurredAt,
      source: eventSource(selectSource(resource.sources), occurredAt),
      resourceId: merged.id,
      ...(existing ? { changedFields: changedResourceFields(existing, merged) } : {}),
    });
    return cloneResource(merged);
  }

  upsertRelation(relation: ResourceRelation): ResourceRelation {
    validateRelationContract(relation);
    this.#assertRelationReferences(relation);
    const existing = this.#relations.get(relation.id);
    this.#assertRelationIdentity(existing, relation);
    if (
      relation.kind === 'contains' &&
      !relation.deletedAt &&
      this.#wouldCreateContainsCycle(
        relation.fromResourceId,
        relation.toResourceId,
        relation.id,
      )
    ) {
      throw new ResourceConflictError(
        `Relation ${relation.id} would create a contains cycle`,
        'RELATION_CYCLE',
      );
    }
    const merged = existing ? mergeRelation(existing, relation) : cloneRelation(relation);
    if (existing && isDeepStrictEqual(existing, merged)) {
      return cloneRelation(existing);
    }
    if (existing) this.#removeRelationIndexes(existing);
    this.#relations.set(merged.id, merged);
    this.#addRelationIndexes(merged);
    const occurredAt = laterTime(merged.updatedAt, this.#snapshotCreatedAt);
    this.#touchSnapshot(occurredAt);
    this.#recordEvent({
      type: existing ? 'relation-updated' : 'relation-created',
      occurredAt,
      source: eventSource(selectSource(relation.sources), occurredAt),
      relationId: merged.id,
      resourceId: merged.fromResourceId,
      relatedResourceId: merged.toResourceId,
      ...(existing ? { changedFields: changedRelationFields(existing, merged) } : {}),
    });
    return cloneRelation(merged);
  }

  addObservation(observation: ResourceObservation): ResourceObservation {
    validateObservationContract(observation);
    if (!this.#resources.has(observation.resourceId)) {
      throw new ResourceConflictError(
        `Observation ${observation.id} references unknown resource ${observation.resourceId}`,
      );
    }
    const byId =
      this.#observations.get(observation.resourceId) ??
      new Map<string, ResourceObservation>();
    const existing = byId.get(observation.id);
    if (existing && existing.resourceId !== observation.resourceId) {
      throw new ResourceConflictError(
        `Observation ${observation.id} cannot change its resource`,
      );
    }
    const cloned = cloneObservation(observation);
    if (existing && isDeepStrictEqual(existing, cloned)) {
      return cloneObservation(existing);
    }
    byId.set(observation.id, cloned);
    compactObservations(byId, this.#maxObservationsPerResource);
    this.#observations.set(observation.resourceId, byId);
    this.#touchSnapshot(observation.observedAt);
    this.#recordEvent({
      type: 'observation-recorded',
      occurredAt: observation.observedAt,
      source: eventSource(observation.source, observation.observedAt),
      resourceId: observation.resourceId,
      attributes: {
        observationId: observation.id,
        category: observation.category,
        status: observation.status,
      },
    });
    return cloneObservation(cloned);
  }

  applyDiscoveryPage(page: ResourceDiscoveryPage): ResourceDiscoveryResult {
    this.#validateBatch(
      page.resources,
      page.relations,
      page.observations ?? [],
      new Set<ResourceRelationId>(),
    );
    for (const resource of page.resources) this.upsertResource(resource);
    for (const relation of page.relations) this.upsertRelation(relation);
    for (const observation of page.observations ?? []) this.addObservation(observation);
    return {
      resources: page.resources.length,
      relations: page.relations.length,
      observations: page.observations?.length ?? 0,
    };
  }

  applyChangeSet(changeSet: ResourceChangeSet): ResourceChangeResult {
    validateChangeSetContract(changeSet);
    const previous = this.#sourceVersions.get(changeSet.sourceId);
    if (previous?.version === changeSet.version) {
      return emptyChangeResult(true);
    }
    if (
      changeSet.sequence !== undefined &&
      previous?.sequence !== undefined &&
      changeSet.sequence <= previous.sequence
    ) {
      throw new ResourceConflictError(
        `Change set ${changeSet.sourceId}:${changeSet.version} is older than sequence ${previous.sequence}`,
        'STALE_CHANGE_SET',
      );
    }
    assertNoOverlap(
      changeSet.deleteResourceIds ?? [],
      changeSet.restoreResourceIds ?? [],
      'A resource cannot be deleted and restored in the same change set',
    );
    this.#validateBatch(
      changeSet.upsertResources ?? [],
      changeSet.upsertRelations ?? [],
      changeSet.observations ?? [],
      new Set(changeSet.deleteRelationIds ?? []),
    );
    this.#validateLifecycleChanges(changeSet);

    let deletedResources = 0;
    let restoredResources = 0;
    let deletedRelations = 0;
    for (const resource of changeSet.upsertResources ?? []) this.upsertResource(resource);
    for (const id of changeSet.deleteResourceIds ?? []) {
      if (this.markResourceDeleted(id, changeSet.observedAt)) deletedResources += 1;
    }
    for (const id of changeSet.restoreResourceIds ?? []) {
      if (this.restoreResource(id, changeSet.observedAt)) restoredResources += 1;
    }
    for (const relation of changeSet.upsertRelations ?? []) this.upsertRelation(relation);
    for (const id of changeSet.deleteRelationIds ?? []) {
      if (this.markRelationDeleted(id, changeSet.observedAt)) deletedRelations += 1;
    }
    for (const observation of changeSet.observations ?? []) {
      this.addObservation(observation);
    }
    this.#sourceVersions.set(changeSet.sourceId, {
      version: changeSet.version,
      ...(changeSet.sequence === undefined ? {} : { sequence: changeSet.sequence }),
    });
    this.#touchSnapshot(changeSet.observedAt);
    this.#recordEvent({
      type: 'change-set-applied',
      occurredAt: changeSet.observedAt,
      source: {
        sourceId: changeSet.sourceId,
        sourceType: 'change-set',
        observedAt: changeSet.observedAt,
      },
      attributes: {
        version: changeSet.version,
        ...(changeSet.sequence === undefined ? {} : { sequence: changeSet.sequence }),
      },
    });
    return {
      upsertedResources: changeSet.upsertResources?.length ?? 0,
      deletedResources,
      restoredResources,
      upsertedRelations: changeSet.upsertRelations?.length ?? 0,
      deletedRelations,
      observations: changeSet.observations?.length ?? 0,
      ignored: false,
    };
  }

  getResource(
    id: ResourceId,
    includeDeleted = false,
  ): ResourceDescriptor | undefined {
    const resource = this.#resources.get(id);
    if (!resource || (!includeDeleted && resource.deletedAt)) return undefined;
    return cloneResource(resource);
  }

  getRelation(
    id: ResourceRelationId,
    includeDeleted = false,
  ): ResourceRelation | undefined {
    const relation = this.#relations.get(id);
    if (!relation || !this.#relationVisible(relation, includeDeleted)) return undefined;
    return cloneRelation(relation);
  }

  query(input: ResourceQuery = {}): ResourceQueryPage {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const afterId = decodeCursor(input.cursor);
    const selected: ResourceDescriptor[] = [];
    let hasMore = false;
    for (const id of this.#candidateIds(input)) {
      if (afterId && id <= afterId) continue;
      const resource = this.#resources.get(id);
      if (!resource || !this.#matches(resource, input)) continue;
      if (selected.length >= limit) {
        hasMore = true;
        break;
      }
      selected.push(resource);
    }
    return {
      items: selected.map(cloneResource),
      ...(hasMore && selected.at(-1)
        ? { nextCursor: encodeCursor(selected.at(-1)!.id) }
        : {}),
    };
  }

  relationsFor(
    resourceId: ResourceId,
    options: {
      direction?: 'outgoing' | 'incoming' | 'both';
      kinds?: ResourceRelationKind[];
      includeDeleted?: boolean;
      scope?: ResourceScope;
    } = {},
  ): ResourceRelation[] {
    const resource = this.#resources.get(resourceId);
    if (
      !resource ||
      !this.#resourceVisible(resource, options.includeDeleted ?? false, options.scope)
    ) {
      return [];
    }
    const direction = options.direction ?? 'both';
    const ids = new Set<ResourceRelationId>();
    if (direction !== 'incoming') {
      for (const id of this.#outgoing.get(resourceId) ?? []) ids.add(id);
    }
    if (direction !== 'outgoing') {
      for (const id of this.#incoming.get(resourceId) ?? []) ids.add(id);
    }
    const kindSet = options.kinds ? new Set<string>(options.kinds) : undefined;
    return [...ids]
      .map((id) => this.#relations.get(id))
      .filter((relation): relation is ResourceRelation => Boolean(relation))
      .filter((relation) => this.#relationVisible(relation, options.includeDeleted ?? false))
      .filter((relation) => !kindSet || kindSet.has(relation.kind))
      .filter((relation) => {
        const otherId =
          relation.fromResourceId === resourceId
            ? relation.toResourceId
            : relation.fromResourceId;
        const other = this.#resources.get(otherId);
        return Boolean(
          other &&
            this.#resourceVisible(
              other,
              options.includeDeleted ?? false,
              options.scope,
            ),
        );
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneRelation);
  }

  neighbors(
    resourceId: ResourceId,
    options: {
      direction?: 'outgoing' | 'incoming' | 'both';
      kinds?: ResourceRelationKind[];
      includeDeleted?: boolean;
      scope?: ResourceScope;
    } = {},
  ): ResourceDescriptor[] {
    const ids = new Set<ResourceId>();
    for (const relation of this.relationsFor(resourceId, options)) {
      if (relation.fromResourceId === resourceId) ids.add(relation.toResourceId);
      if (relation.toResourceId === resourceId) ids.add(relation.fromResourceId);
    }
    return [...ids]
      .map((id) => this.#resources.get(id))
      .filter((resource): resource is ResourceDescriptor => Boolean(resource))
      .filter((resource) =>
        this.#resourceVisible(
          resource,
          options.includeDeleted ?? false,
          options.scope,
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneResource);
  }

  traverse(request: ResourceTraversalRequest): ResourceTraversalResult {
    validateTraversal(request);
    const nodes: ResourceTraversalResult['nodes'] = [];
    const relations = new Map<ResourceRelationId, ResourceRelation>();
    const visited = new Set<ResourceId>();
    const queue: Array<{ id: ResourceId; depth: number; viaRelationId?: string }> = [];
    let truncated = false;
    for (const id of request.startResourceIds) {
      const resource = this.#resources.get(id);
      if (
        !resource ||
        visited.has(id) ||
        !this.#resourceVisible(
          resource,
          request.includeDeleted ?? false,
          request.scope,
        )
      ) {
        continue;
      }
      if (visited.size >= request.maxResources) {
        truncated = true;
        break;
      }
      visited.add(id);
      queue.push({ id, depth: 0 });
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      const resource = this.#resources.get(current.id);
      if (!resource) continue;
      nodes.push({
        resource: cloneResource(resource),
        depth: current.depth,
        ...(current.viaRelationId ? { viaRelationId: current.viaRelationId } : {}),
      });
      if (current.depth >= request.maxDepth) continue;
      const adjacent = this.relationsFor(current.id, {
        direction: request.direction ?? 'both',
        ...(request.relationKinds ? { kinds: request.relationKinds } : {}),
        ...(request.includeDeleted === undefined
          ? {}
          : { includeDeleted: request.includeDeleted }),
        ...(request.scope ? { scope: request.scope } : {}),
      });
      for (const relation of adjacent) {
        const nextId =
          relation.fromResourceId === current.id
            ? relation.toResourceId
            : relation.fromResourceId;
        relations.set(relation.id, relation);
        if (visited.has(nextId)) continue;
        if (visited.size >= request.maxResources) {
          truncated = true;
          continue;
        }
        visited.add(nextId);
        queue.push({
          id: nextId,
          depth: current.depth + 1,
          viaRelationId: relation.id,
        });
      }
    }
    return {
      nodes,
      relations: [...relations.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      truncated,
    };
  }

  observationsFor(
    resourceId: ResourceId,
    options: {
      includeExpired?: boolean;
      category?: string;
      at?: string;
      limit?: number;
    } = {},
  ): ResourceObservation[] {
    const atText = options.at ?? this.#now();
    const at = Date.parse(requireCanonicalTime(atText, 'at'));
    const limit = Math.min(
      Math.max(options.limit ?? this.#maxObservationsPerResource, 1),
      this.#maxObservationsPerResource,
    );
    return [...(this.#observations.get(resourceId)?.values() ?? [])]
      .filter((item) => Date.parse(item.observedAt) <= at)
      .filter((item) => !options.category || item.category === options.category)
      .filter((item) => options.includeExpired || Date.parse(item.expiresAt) > at)
      .sort(compareObservationsDescending)
      .slice(0, limit)
      .map(cloneObservation);
  }

  resolveFact(resourceId: ResourceId, key: string): ResolvedResourceFact | undefined {
    const resource = this.#resources.get(resourceId);
    const facts = resource?.facts?.[key];
    if (!facts || facts.length === 0) return undefined;
    const candidates = facts.map(cloneFact).sort(compareFacts);
    const distinctValues = new Set(candidates.map((fact) => stableValueKey(fact.value)));
    return {
      key,
      selected: candidates[0]!,
      candidates,
      conflicted: distinctValues.size > 1,
    };
  }

  state(
    resourceId: ResourceId,
    options: { asOf?: string } = {},
  ): ResourceStateSnapshot | undefined {
    const resource = this.#resources.get(resourceId);
    if (!resource) return undefined;
    const asOf = requireCanonicalTime(options.asOf ?? this.#now(), 'asOf');
    const at = Date.parse(asOf);
    const observations = [...(this.#observations.get(resourceId)?.values() ?? [])]
      .filter((item) => Date.parse(item.observedAt) <= at)
      .sort(compareObservationsDescending);
    const categories = new Map<string, ResourceObservation[]>();
    for (const observation of observations) {
      const values = categories.get(observation.category) ?? [];
      values.push(observation);
      categories.set(observation.category, values);
    }
    const categoryStates = [...categories.entries()]
      .map(([category, values]) => deriveCategoryState(category, values, at))
      .sort((left, right) => left.category.localeCompare(right.category));
    const freshCategories = categoryStates.filter(
      (category) => category.freshness === 'fresh',
    );
    const selectedCategories =
      freshCategories.length > 0 ? freshCategories : categoryStates;
    const status =
      selectedCategories.length === 0
        ? 'unknown'
        : worstStatus(
            selectedCategories.map((category) =>
              normalizeStatusForOverallState(category.status),
            ),
          );
    const freshness: ResourceFreshness =
      freshCategories.length > 0
        ? 'fresh'
        : categoryStates.length > 0
          ? 'stale'
          : 'unknown';
    return {
      resourceId,
      asOf,
      lifecycle: resource.deletedAt ? 'deleted' : 'active',
      status,
      freshness,
      categories: categoryStates,
      factConflicts: Object.keys(resource.facts ?? {})
        .filter((key) => this.resolveFact(resourceId, key)?.conflicted)
        .sort(),
    };
  }

  events(input: ResourceEventQuery = {}): ResourceEventPage {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const typeSet = input.types ? new Set<ResourceEventType>(input.types) : undefined;
    const items = this.#events
      .filter((event) => event.sequence > (input.afterSequence ?? 0))
      .filter(
        (event) =>
          !input.resourceId ||
          event.resourceId === input.resourceId ||
          event.relatedResourceId === input.resourceId,
      )
      .filter((event) => !typeSet || typeSet.has(event.type));
    const selected = items.slice(0, limit).map(cloneEvent);
    return {
      items: selected,
      ...(items.length > selected.length && selected.at(-1)
        ? { nextSequence: selected.at(-1)!.sequence }
        : {}),
    };
  }

  markResourceDeleted(
    id: ResourceId,
    deletedAt = this.#now(),
    source?: ResourceSource,
  ): boolean {
    const resource = this.#resources.get(id);
    if (!resource || resource.deletedAt) return false;
    const timestamp = requireCanonicalTime(deletedAt, 'deletedAt');
    if (timestamp < resource.updatedAt) {
      throw new ResourceConflictError(
        `Resource ${id} cannot be deleted before its latest update`,
        'RESOURCE_VALIDATION_FAILED',
      );
    }
    const updated: ResourceDescriptor = {
      ...resource,
      deletedAt: timestamp,
      updatedAt: timestamp,
      version: resource.version + 1,
    };
    this.#resources.set(id, updated);
    this.#touchSnapshot(timestamp);
    this.#recordEvent({
      type: 'resource-deleted',
      occurredAt: timestamp,
      source: eventSource(source ?? selectSource(resource.sources), timestamp),
      resourceId: id,
    });
    return true;
  }

  restoreResource(
    id: ResourceId,
    restoredAt = this.#now(),
    source?: ResourceSource,
  ): boolean {
    const resource = this.#resources.get(id);
    if (!resource?.deletedAt) return false;
    const timestamp = requireCanonicalTime(restoredAt, 'restoredAt');
    if (timestamp < resource.deletedAt) {
      throw new ResourceConflictError(
        `Resource ${id} cannot be restored before it was deleted`,
        'RESOURCE_VALIDATION_FAILED',
      );
    }
    const updated: ResourceDescriptor = {
      ...resource,
      updatedAt: timestamp,
      version: resource.version + 1,
    };
    delete updated.deletedAt;
    this.#resources.set(id, updated);
    this.#touchSnapshot(timestamp);
    this.#recordEvent({
      type: 'resource-restored',
      occurredAt: timestamp,
      source: eventSource(source ?? selectSource(resource.sources), timestamp),
      resourceId: id,
    });
    return true;
  }

  markRelationDeleted(
    id: ResourceRelationId,
    deletedAt = this.#now(),
    source?: ResourceSource,
  ): boolean {
    const relation = this.#relations.get(id);
    if (!relation || relation.deletedAt) return false;
    const timestamp = requireCanonicalTime(deletedAt, 'deletedAt');
    if (timestamp < relation.updatedAt) {
      throw new ResourceConflictError(
        `Relation ${id} cannot be deleted before its latest update`,
        'RESOURCE_VALIDATION_FAILED',
      );
    }
    const updated: ResourceRelation = {
      ...relation,
      deletedAt: timestamp,
      updatedAt: timestamp,
      version: relation.version + 1,
    };
    this.#relations.set(id, updated);
    this.#touchSnapshot(timestamp);
    this.#recordEvent({
      type: 'relation-deleted',
      occurredAt: timestamp,
      source: eventSource(source ?? selectSource(relation.sources), timestamp),
      relationId: id,
      resourceId: relation.fromResourceId,
      relatedResourceId: relation.toResourceId,
    });
    return true;
  }

  restoreRelation(
    id: ResourceRelationId,
    restoredAt = this.#now(),
    source?: ResourceSource,
  ): boolean {
    const relation = this.#relations.get(id);
    if (!relation?.deletedAt) return false;
    const timestamp = requireCanonicalTime(restoredAt, 'restoredAt');
    if (timestamp < relation.deletedAt) {
      throw new ResourceConflictError(
        `Relation ${id} cannot be restored before it was deleted`,
        'RESOURCE_VALIDATION_FAILED',
      );
    }
    if (
      relation.kind === 'contains' &&
      this.#wouldCreateContainsCycle(
        relation.fromResourceId,
        relation.toResourceId,
        relation.id,
      )
    ) {
      throw new ResourceConflictError(
        `Relation ${id} would create a contains cycle`,
        'RELATION_CYCLE',
      );
    }
    const updated: ResourceRelation = {
      ...relation,
      updatedAt: timestamp,
      version: relation.version + 1,
    };
    delete updated.deletedAt;
    this.#relations.set(id, updated);
    this.#touchSnapshot(timestamp);
    this.#recordEvent({
      type: 'relation-updated',
      occurredAt: timestamp,
      source: eventSource(source ?? selectSource(relation.sources), timestamp),
      relationId: id,
      resourceId: relation.fromResourceId,
      relatedResourceId: relation.toResourceId,
      changedFields: ['deletedAt'],
    });
    return true;
  }

  bindResources(
    primaryId: ResourceId,
    duplicateId: ResourceId,
    source: ResourceSource,
  ): ResourceDescriptor {
    if (primaryId === duplicateId) {
      const existing = this.getResource(primaryId, true);
      if (!existing) throw new ResourceConflictError(`Unknown resource ${primaryId}`);
      return existing;
    }
    const primary = this.#resources.get(primaryId);
    const duplicate = this.#resources.get(duplicateId);
    if (!primary || !duplicate) {
      throw new ResourceConflictError('Both resources must exist before they can be bound');
    }
    if (primary.deletedAt || duplicate.deletedAt) {
      throw new ResourceConflictError('Deleted resources cannot be bound');
    }
    if (primary.kind !== duplicate.kind) {
      throw new ResourceConflictError('Resources of different kinds cannot be bound');
    }
    validateResourceSourceForRuntime(source);
    const now = source.observedAt;
    const mergedFacts = mergeFacts(duplicate.facts, primary.facts);
    const mergedInput: ResourceDescriptor = {
      ...primary,
      aliases: unique([
        ...(primary.aliases ?? []),
        duplicate.nativeId,
        duplicate.canonicalName,
        ...(duplicate.aliases ?? []),
      ]),
      attributes: { ...(duplicate.attributes ?? {}), ...(primary.attributes ?? {}) },
      ...(mergedFacts ? { facts: mergedFacts } : {}),
      sources: mergeSources([...primary.sources, ...duplicate.sources, source]),
      version: Math.max(primary.version, duplicate.version) + 1,
      updatedAt: laterTime(now, primary.updatedAt),
    };
    const merged = this.upsertResource(mergedInput);
    for (const relation of this.relationsFor(duplicateId, {
      includeDeleted: true,
    })) {
      this.markRelationDeleted(relation.id, now, source);
      const fromResourceId =
        relation.fromResourceId === duplicateId ? primaryId : relation.fromResourceId;
      const toResourceId =
        relation.toResourceId === duplicateId ? primaryId : relation.toResourceId;
      if (fromResourceId !== toResourceId) {
        const activeRelation = cloneRelation(relation);
        delete activeRelation.deletedAt;
        this.upsertRelation({
          ...activeRelation,
          id: createStableRelationId({
            kind: relation.kind,
            fromResourceId,
            toResourceId,
          }),
          fromResourceId,
          toResourceId,
          version: relation.version + 1,
          updatedAt: now,
          sources: mergeSources([...relation.sources, source]),
        });
      }
    }
    this.markResourceDeleted(duplicateId, now, source);
    this.#recordEvent({
      type: 'resource-bound',
      occurredAt: now,
      source: eventSource(source, now),
      resourceId: primaryId,
      relatedResourceId: duplicateId,
    });
    return merged;
  }

  snapshot(): ResourceRegistrySnapshot {
    return {
      contractVersion: CURRENT_CONTRACT_VERSION,
      createdAt: this.#snapshotCreatedAt,
      resources: [...this.#resources.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneResource),
      relations: [...this.#relations.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneRelation),
      observations: [...this.#observations.values()]
        .flatMap((items) => [...items.values()])
        .sort(compareObservationsDescending)
        .map(cloneObservation),
      events: this.#events.map(cloneEvent),
      sourceVersions: Object.fromEntries(
        [...this.#sourceVersions.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sourceId, version]) => [sourceId, { ...version }]),
      ),
      lastEventSequence: this.#lastEventSequence,
    };
  }

  restore(snapshot: ResourceRegistrySnapshot): void {
    try {
      assertResourceRegistrySnapshot(snapshot);
    } catch (error) {
      throw contractError(error);
    }
    const preparedSnapshot = structuredClone(snapshot);
    const preparedResources = new Map<ResourceId, ResourceDescriptor>();
    for (const resource of preparedSnapshot.resources) {
      if (preparedResources.has(resource.id)) {
        throw new ResourceConflictError(
          `Snapshot contains duplicate resource ${resource.id}`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
      preparedResources.set(resource.id, resource);
    }
    const preparedRelations = new Map<ResourceRelationId, ResourceRelation>();
    for (const relation of preparedSnapshot.relations) {
      if (preparedRelations.has(relation.id)) {
        throw new ResourceConflictError(
          `Snapshot contains duplicate relation ${relation.id}`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
      if (
        !preparedResources.has(relation.fromResourceId) ||
        !preparedResources.has(relation.toResourceId)
      ) {
        throw new ResourceConflictError(
          `Relation ${relation.id} references an unknown resource`,
        );
      }
      preparedRelations.set(relation.id, relation);
    }
    assertContainsGraphAcyclic(preparedRelations.values());

    const preparedObservations = new Map<
      ResourceId,
      Map<string, ResourceObservation>
    >();
    for (const observation of preparedSnapshot.observations) {
      if (!preparedResources.has(observation.resourceId)) {
        throw new ResourceConflictError(
          `Observation ${observation.id} references unknown resource ${observation.resourceId}`,
        );
      }
      const observations =
        preparedObservations.get(observation.resourceId) ??
        new Map<string, ResourceObservation>();
      if (observations.has(observation.id)) {
        throw new ResourceConflictError(
          `Snapshot contains duplicate observation ${observation.id} for ${observation.resourceId}`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
      observations.set(observation.id, observation);
      compactObservations(observations, this.#maxObservationsPerResource);
      preparedObservations.set(observation.resourceId, observations);
    }
    const preparedEvents = preparedSnapshot.events.slice(-this.#maxEvents);
    const preparedSourceVersions = new Map(
      Object.entries(preparedSnapshot.sourceVersions),
    );

    this.clear();
    for (const [id, resource] of preparedResources) {
      this.#resources.set(id, resource);
      addToIndex(this.#byKind, resource.kind, id);
      if (resource.engine) addToIndex(this.#byEngine, resource.engine, id);
    }
    for (const [id, relation] of preparedRelations) {
      this.#relations.set(id, relation);
      addToIndex(this.#outgoing, relation.fromResourceId, id);
      addToIndex(this.#incoming, relation.toResourceId, id);
    }
    for (const [resourceId, observations] of preparedObservations) {
      this.#observations.set(resourceId, observations);
    }
    for (const [sourceId, version] of preparedSourceVersions) {
      this.#sourceVersions.set(sourceId, version);
    }
    this.#events.splice(0, this.#events.length, ...preparedEvents);
    this.#lastEventSequence = preparedSnapshot.lastEventSequence;
    this.#snapshotCreatedAt = preparedSnapshot.createdAt;
  }

  clear(): void {
    this.#resources.clear();
    this.#relations.clear();
    this.#outgoing.clear();
    this.#incoming.clear();
    this.#byKind.clear();
    this.#byEngine.clear();
    this.#sortedKindIds.clear();
    this.#sortedEngineIds.clear();
    this.#observations.clear();
    this.#sourceVersions.clear();
    this.#events.splice(0);
    this.#lastEventSequence = 0;
    this.#sortedResourceIds = undefined;
    this.#snapshotCreatedAt = requireCanonicalTime(this.#now(), 'now()');
  }

  get size(): number {
    return this.#resources.size;
  }

  get relationCount(): number {
    return this.#relations.size;
  }

  get observationCount(): number {
    let count = 0;
    for (const observations of this.#observations.values()) count += observations.size;
    return count;
  }

  get eventCount(): number {
    return this.#events.length;
  }

  #validateBatch(
    resources: ResourceDescriptor[],
    relations: ResourceRelation[],
    observations: ResourceObservation[],
    deletedRelationIds: Set<ResourceRelationId>,
  ): void {
    const availableResources = new Map(this.#resources);
    for (const resource of resources) {
      validateResourceContract(resource);
      this.#assertResourceIdentity(availableResources.get(resource.id), resource);
      const existing = availableResources.get(resource.id);
      availableResources.set(
        resource.id,
        existing ? mergeResource(existing, resource) : cloneResource(resource),
      );
    }
    const availableRelations = new Map(this.#relations);
    for (const relationId of deletedRelationIds) availableRelations.delete(relationId);
    for (const relation of relations) {
      validateRelationContract(relation);
      if (
        !availableResources.has(relation.fromResourceId) ||
        !availableResources.has(relation.toResourceId)
      ) {
        throw new ResourceConflictError(
          `Relation ${relation.id} references an unknown resource`,
        );
      }
      this.#assertRelationIdentity(availableRelations.get(relation.id), relation);
      availableRelations.set(relation.id, cloneRelation(relation));
    }
    assertContainsGraphAcyclic(availableRelations.values());
    for (const observation of observations) {
      validateObservationContract(observation);
      if (!availableResources.has(observation.resourceId)) {
        throw new ResourceConflictError(
          `Observation ${observation.id} references unknown resource ${observation.resourceId}`,
        );
      }
    }
  }

  #validateLifecycleChanges(changeSet: ResourceChangeSet): void {
    const projectedResources = new Map(this.#resources);
    for (const incoming of changeSet.upsertResources ?? []) {
      const existing = projectedResources.get(incoming.id);
      projectedResources.set(
        incoming.id,
        existing ? mergeResource(existing, incoming) : cloneResource(incoming),
      );
    }
    for (const id of changeSet.deleteResourceIds ?? []) {
      const resource = projectedResources.get(id);
      if (
        resource &&
        !resource.deletedAt &&
        changeSet.observedAt < resource.updatedAt
      ) {
        throw new ResourceConflictError(
          `Resource ${id} cannot be deleted before its latest update`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
    }
    for (const id of changeSet.restoreResourceIds ?? []) {
      const resource = projectedResources.get(id);
      if (
        resource?.deletedAt &&
        changeSet.observedAt < resource.deletedAt
      ) {
        throw new ResourceConflictError(
          `Resource ${id} cannot be restored before it was deleted`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
    }

    const projectedRelations = new Map(this.#relations);
    for (const incoming of changeSet.upsertRelations ?? []) {
      const existing = projectedRelations.get(incoming.id);
      projectedRelations.set(
        incoming.id,
        existing ? mergeRelation(existing, incoming) : cloneRelation(incoming),
      );
    }
    for (const id of changeSet.deleteRelationIds ?? []) {
      const relation = projectedRelations.get(id);
      if (
        relation &&
        !relation.deletedAt &&
        changeSet.observedAt < relation.updatedAt
      ) {
        throw new ResourceConflictError(
          `Relation ${id} cannot be deleted before its latest update`,
          'RESOURCE_VALIDATION_FAILED',
        );
      }
    }
  }

  #assertResourceIdentity(
    existing: ResourceDescriptor | undefined,
    incoming: ResourceDescriptor,
  ): void {
    if (
      existing &&
      (existing.kind !== incoming.kind ||
        (existing.nativeId !== incoming.nativeId &&
          !existing.aliases?.includes(incoming.nativeId) &&
          !incoming.aliases?.includes(existing.nativeId)))
    ) {
      throw new ResourceConflictError(
        `Resource ${incoming.id} cannot change identity from ${existing.kind}:${existing.nativeId} to ${incoming.kind}:${incoming.nativeId}`,
      );
    }
  }

  #assertRelationIdentity(
    existing: ResourceRelation | undefined,
    incoming: ResourceRelation,
  ): void {
    if (
      existing &&
      (existing.kind !== incoming.kind ||
        existing.fromResourceId !== incoming.fromResourceId ||
        existing.toResourceId !== incoming.toResourceId)
    ) {
      throw new ResourceConflictError(
        `Relation ${incoming.id} cannot change its identity`,
      );
    }
  }

  #assertRelationReferences(relation: ResourceRelation): void {
    if (
      !this.#resources.has(relation.fromResourceId) ||
      !this.#resources.has(relation.toResourceId)
    ) {
      throw new ResourceConflictError(
        `Relation ${relation.id} references an unknown resource`,
      );
    }
  }

  #wouldCreateContainsCycle(
    fromResourceId: ResourceId,
    toResourceId: ResourceId,
    replacingRelationId?: ResourceRelationId,
  ): boolean {
    const stack = [toResourceId];
    const visited = new Set<ResourceId>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === fromResourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const relationId of this.#outgoing.get(current) ?? []) {
        if (relationId === replacingRelationId) continue;
        const relation = this.#relations.get(relationId);
        if (relation?.kind === 'contains' && !relation.deletedAt) {
          stack.push(relation.toResourceId);
        }
      }
    }
    return false;
  }

  #addResourceIndexes(resource: ResourceDescriptor): void {
    addToIndex(this.#byKind, resource.kind, resource.id);
    if (resource.engine) addToIndex(this.#byEngine, resource.engine, resource.id);
    this.#invalidateResourceOrder();
  }

  #removeResourceIndexes(resource: ResourceDescriptor): void {
    removeFromIndex(this.#byKind, resource.kind, resource.id);
    if (resource.engine) removeFromIndex(this.#byEngine, resource.engine, resource.id);
    this.#invalidateResourceOrder();
  }

  #addRelationIndexes(relation: ResourceRelation): void {
    addToIndex(this.#outgoing, relation.fromResourceId, relation.id);
    addToIndex(this.#incoming, relation.toResourceId, relation.id);
  }

  #removeRelationIndexes(relation: ResourceRelation): void {
    removeFromIndex(this.#outgoing, relation.fromResourceId, relation.id);
    removeFromIndex(this.#incoming, relation.toResourceId, relation.id);
  }

  #candidateIds(input: ResourceQuery): Iterable<ResourceId> {
    if (input.ids) return [...new Set(input.ids)].sort();
    if (input.parentResourceId) {
      return this.neighbors(input.parentResourceId, {
        direction: 'outgoing',
        kinds: ['contains'],
        ...(input.includeDeleted === undefined
          ? {}
          : { includeDeleted: input.includeDeleted }),
        ...(input.scope ? { scope: input.scope } : {}),
      }).map((item) => item.id);
    }
    if (input.kinds?.length === 1) {
      const kind = input.kinds[0] ?? '';
      const cached = this.#sortedKindIds.get(kind);
      if (cached) return cached;
      const sorted = [...(this.#byKind.get(kind) ?? [])].sort();
      this.#sortedKindIds.set(kind, sorted);
      return sorted;
    }
    if (input.engine) {
      const cached = this.#sortedEngineIds.get(input.engine);
      if (cached) return cached;
      const sorted = [...(this.#byEngine.get(input.engine) ?? [])].sort();
      this.#sortedEngineIds.set(input.engine, sorted);
      return sorted;
    }
    this.#sortedResourceIds ??= [...this.#resources.keys()].sort();
    return this.#sortedResourceIds;
  }

  #invalidateResourceOrder(): void {
    this.#sortedResourceIds = undefined;
    this.#sortedKindIds.clear();
    this.#sortedEngineIds.clear();
  }

  #matches(resource: ResourceDescriptor, input: ResourceQuery): boolean {
    if (!this.#resourceVisible(resource, input.includeDeleted ?? false, input.scope)) {
      return false;
    }
    if (input.kinds && !input.kinds.includes(resource.kind)) return false;
    if (input.engine && resource.engine !== input.engine) return false;
    if (input.text) {
      const needle = input.text.toLocaleLowerCase();
      const values = [
        resource.canonicalName,
        resource.displayName ?? '',
        resource.nativeId,
        ...(resource.aliases ?? []),
      ];
      if (!values.some((value) => value.toLocaleLowerCase().includes(needle))) return false;
    }
    return true;
  }

  #resourceVisible(
    resource: ResourceDescriptor,
    includeDeleted: boolean,
    scope?: ResourceScope,
  ): boolean {
    return (
      (includeDeleted || !resource.deletedAt) &&
      (!scope || scopeMatches(resource.scope, scope))
    );
  }

  #relationVisible(relation: ResourceRelation, includeDeleted: boolean): boolean {
    if (!includeDeleted && relation.deletedAt) return false;
    const from = this.#resources.get(relation.fromResourceId);
    const to = this.#resources.get(relation.toResourceId);
    if (!from || !to) return false;
    return includeDeleted || (!from.deletedAt && !to.deletedAt);
  }

  #recordEvent(
    input: Omit<ResourceEvent, 'id' | 'sequence'>,
  ): void {
    const event: ResourceEvent = {
      ...input,
      id: this.#createEventId(),
      sequence: this.#lastEventSequence + 1,
    };
    this.#lastEventSequence = event.sequence;
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  #touchSnapshot(timestamp: string): void {
    this.#snapshotCreatedAt = laterTime(
      requireCanonicalTime(timestamp, 'timestamp'),
      this.#snapshotCreatedAt,
    );
  }

}

function mergeResource(
  existing: ResourceDescriptor,
  incoming: ResourceDescriptor,
): ResourceDescriptor {
  const incomingWins = incoming.updatedAt >= existing.updatedAt;
  const older = incomingWins ? existing : incoming;
  const newer = incomingWins ? incoming : existing;
  const facts = mergeFacts(existing.facts, incoming.facts);
  const merged: ResourceDescriptor = {
    ...older,
    ...newer,
    aliases: unique([...(existing.aliases ?? []), ...(incoming.aliases ?? [])]),
    tags: { ...(older.tags ?? {}), ...(newer.tags ?? {}) },
    attributes: { ...(older.attributes ?? {}), ...(newer.attributes ?? {}) },
    ...(facts ? { facts } : {}),
    sources: mergeSources([...existing.sources, ...incoming.sources]),
    firstSeenAt:
      existing.firstSeenAt < incoming.firstSeenAt
        ? existing.firstSeenAt
        : incoming.firstSeenAt,
    updatedAt: laterTime(existing.updatedAt, incoming.updatedAt),
    version: Math.max(existing.version, incoming.version),
  };
  if (existing.deletedAt || incoming.deletedAt) {
    merged.deletedAt = laterOptionalTime(existing.deletedAt, incoming.deletedAt)!;
  } else {
    delete merged.deletedAt;
  }
  return merged;
}

function mergeRelation(
  existing: ResourceRelation,
  incoming: ResourceRelation,
): ResourceRelation {
  const incomingWins = incoming.updatedAt >= existing.updatedAt;
  const older = incomingWins ? existing : incoming;
  const newer = incomingWins ? incoming : existing;
  const merged: ResourceRelation = {
    ...older,
    ...newer,
    attributes: { ...(older.attributes ?? {}), ...(newer.attributes ?? {}) },
    sources: mergeSources([...existing.sources, ...incoming.sources]),
    firstSeenAt:
      existing.firstSeenAt < incoming.firstSeenAt
        ? existing.firstSeenAt
        : incoming.firstSeenAt,
    updatedAt: laterTime(existing.updatedAt, incoming.updatedAt),
    version: Math.max(existing.version, incoming.version),
  };
  if (existing.deletedAt || incoming.deletedAt) {
    merged.deletedAt = laterOptionalTime(existing.deletedAt, incoming.deletedAt)!;
  } else {
    delete merged.deletedAt;
  }
  return merged;
}

function mergeFacts(
  left: ResourceDescriptor['facts'],
  right: ResourceDescriptor['facts'],
): ResourceDescriptor['facts'] {
  if (!left && !right) return undefined;
  const merged: NonNullable<ResourceDescriptor['facts']> = {};
  for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    const bySource = new Map<string, ResourceFact>();
    for (const fact of [...(left?.[key] ?? []), ...(right?.[key] ?? [])]) {
      const sourceKey = resourceSourceKey(fact.source);
      const current = bySource.get(sourceKey);
      if (!current || compareSourceRecency(current.source, fact.source) <= 0) {
        bySource.set(sourceKey, cloneFact(fact));
      }
    }
    merged[key] = [...bySource.values()].sort(compareFacts);
  }
  return merged;
}

function mergeSources(sources: ResourceSource[]): ResourceSource[] {
  const byKey = new Map<string, ResourceSource>();
  for (const source of sources) {
    const key = resourceSourceKey(source);
    const current = byKey.get(key);
    if (!current || compareSourceRecency(current, source) <= 0) {
      byKey.set(key, { ...source });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    resourceSourceKey(left).localeCompare(resourceSourceKey(right)),
  );
}

function compareFacts(left: ResourceFact, right: ResourceFact): number {
  return (
    (right.source.priority ?? 0) - (left.source.priority ?? 0) ||
    (right.confidence ?? 0) - (left.confidence ?? 0) ||
    right.source.observedAt.localeCompare(left.source.observedAt) ||
    resourceSourceKey(left.source).localeCompare(resourceSourceKey(right.source))
  );
}

function compareSourceRecency(left: ResourceSource, right: ResourceSource): number {
  return (
    left.observedAt.localeCompare(right.observedAt) ||
    (left.priority ?? 0) - (right.priority ?? 0)
  );
}

function selectSource(sources: ResourceSource[]): ResourceSource {
  const selected = [...sources].sort((left, right) => {
    return (
      (right.priority ?? 0) - (left.priority ?? 0) ||
      right.observedAt.localeCompare(left.observedAt) ||
      resourceSourceKey(left).localeCompare(resourceSourceKey(right))
    );
  })[0];
  if (!selected) {
    throw new ResourceConflictError(
      'Resource source list cannot be empty',
      'RESOURCE_VALIDATION_FAILED',
    );
  }
  return selected;
}

function eventSource(source: ResourceSource, observedAt: string): ResourceSource {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    ...(source.connectorId ? { connectorId: source.connectorId } : {}),
    ...(source.connectionProfileId
      ? { connectionProfileId: source.connectionProfileId }
      : {}),
    ...(source.priority === undefined ? {} : { priority: source.priority }),
    observedAt,
  };
}

function resourceSourceKey(source: ResourceSource): string {
  return `${source.sourceType}:${source.sourceId}:${source.connectionProfileId ?? ''}`;
}

function deriveCategoryState(
  category: string,
  observations: ResourceObservation[],
  at: number,
): ResourceCategoryState {
  const latestBySource = new Map<string, ResourceObservation>();
  for (const observation of observations) {
    const key = resourceSourceKey(observation.source);
    const current = latestBySource.get(key);
    if (!current || compareObservationsDescending(observation, current) < 0) {
      latestBySource.set(key, observation);
    }
  }
  const latest = [...latestBySource.values()].sort(compareObservationsDescending);
  const fresh = latest.filter((observation) => Date.parse(observation.expiresAt) > at);
  const selected = fresh.length > 0 ? fresh : latest;
  const statuses = selected.map((observation) => observation.status);
  const newest = selected[0];
  return {
    category,
    status: statuses.length > 0 ? worstStatus(statuses) : 'unknown',
    freshness: fresh.length > 0 ? 'fresh' : selected.length > 0 ? 'stale' : 'unknown',
    ...(newest
      ? { observedAt: newest.observedAt, expiresAt: newest.expiresAt }
      : {}),
    observationIds: selected.map((observation) => observation.id).sort(),
    sourceIds: selected
      .map((observation) => observation.source.sourceId)
      .sort(),
    conflicted: new Set(statuses).size > 1,
  };
}

function worstStatus(statuses: ObservationStatus[]): ObservationStatus {
  const severity = new Map<string, number>([
    ['healthy', 0],
    ['unknown', 1],
    ['collecting', 2],
    ['degraded', 3],
    ['unavailable', 4],
  ]);
  return [...statuses].sort(
    (left, right) =>
      (severity.get(right) ?? severity.get('unknown')!) -
        (severity.get(left) ?? severity.get('unknown')!) ||
      left.localeCompare(right),
  )[0] ?? 'unknown';
}

function normalizeStatusForOverallState(
  status: ObservationStatus,
): ObservationStatus {
  return ['healthy', 'unknown', 'collecting', 'degraded', 'unavailable'].includes(
    status,
  )
    ? status
    : 'unknown';
}

function compactObservations(
  observations: Map<string, ResourceObservation>,
  limit: number,
): void {
  while (observations.size > limit) {
    let oldest: ResourceObservation | undefined;
    for (const observation of observations.values()) {
      if (
        oldest === undefined ||
        compareObservationsDescending(observation, oldest) > 0
      ) {
        oldest = observation;
      }
    }
    if (!oldest) return;
    observations.delete(oldest.id);
  }
}

function compareObservationsDescending(
  left: ResourceObservation,
  right: ResourceObservation,
): number {
  return (
    right.observedAt.localeCompare(left.observedAt) ||
    right.expiresAt.localeCompare(left.expiresAt) ||
    left.id.localeCompare(right.id)
  );
}

function assertContainsGraphAcyclic(relations: Iterable<ResourceRelation>): void {
  const adjacency = new Map<ResourceId, ResourceId[]>();
  const indegree = new Map<ResourceId, number>();
  for (const relation of relations) {
    if (relation.kind !== 'contains' || relation.deletedAt) continue;
    const targets = adjacency.get(relation.fromResourceId) ?? [];
    targets.push(relation.toResourceId);
    adjacency.set(relation.fromResourceId, targets);
    indegree.set(
      relation.toResourceId,
      (indegree.get(relation.toResourceId) ?? 0) + 1,
    );
    if (!indegree.has(relation.fromResourceId)) {
      indegree.set(relation.fromResourceId, 0);
    }
  }
  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let cursor = 0;
  let visited = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++]!;
    visited += 1;
    for (const child of adjacency.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (visited !== indegree.size) {
    const cycleAt =
      [...indegree.entries()].find(([, count]) => count > 0)?.[0] ?? 'unknown';
    throw new ResourceConflictError(
      `Contains hierarchy contains a cycle at ${cycleAt}`,
      'RELATION_CYCLE',
    );
  }
}

function validateTraversal(request: ResourceTraversalRequest): void {
  if (!Array.isArray(request.startResourceIds) || request.startResourceIds.length === 0) {
    throw new ResourceConflictError(
      'Traversal requires at least one start resource',
      'TRAVERSAL_LIMIT_INVALID',
    );
  }
  if (
    !Number.isSafeInteger(request.maxDepth) ||
    request.maxDepth < 0 ||
    request.maxDepth > MAX_TRAVERSAL_DEPTH
  ) {
    throw new ResourceConflictError(
      `maxDepth must be between 0 and ${MAX_TRAVERSAL_DEPTH}`,
      'TRAVERSAL_LIMIT_INVALID',
    );
  }
  if (
    !Number.isSafeInteger(request.maxResources) ||
    request.maxResources < 1 ||
    request.maxResources > MAX_TRAVERSAL_RESOURCES
  ) {
    throw new ResourceConflictError(
      `maxResources must be between 1 and ${MAX_TRAVERSAL_RESOURCES}`,
      'TRAVERSAL_LIMIT_INVALID',
    );
  }
}

function scopeMatches(actual: ResourceScope | undefined, required: ResourceScope): boolean {
  for (const [key, value] of Object.entries(required)) {
    if (
      value !== undefined &&
      actual?.[key as keyof ResourceScope] !== value
    ) {
      return false;
    }
  }
  return true;
}

function changedResourceFields(
  existing: ResourceDescriptor,
  incoming: ResourceDescriptor,
): string[] {
  return changedFields(existing, incoming, [
    'canonicalName',
    'displayName',
    'aliases',
    'engine',
    'engineVersion',
    'scope',
    'tags',
    'attributes',
    'facts',
    'version',
    'updatedAt',
    'deletedAt',
    'sources',
  ]);
}

function changedRelationFields(
  existing: ResourceRelation,
  incoming: ResourceRelation,
): string[] {
  return changedFields(existing, incoming, [
    'attributes',
    'version',
    'updatedAt',
    'deletedAt',
    'sources',
  ]);
}

function changedFields<T extends object>(
  existing: T,
  incoming: T,
  fields: Array<keyof T>,
): string[] {
  return fields
    .filter((field) => !isDeepStrictEqual(existing[field], incoming[field]))
    .map(String);
}

function stableValueKey(value: PortableValue): string {
  if (value === null || typeof value !== 'object') {
    return `${typeof value}:${String(value)}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValueKey).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValueKey(item)}`)
    .join(',')}}`;
}

function addToIndex<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function removeFromIndex<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const values = map.get(key);
  if (!values) return;
  values.delete(value);
  if (values.size === 0) map.delete(key);
}

function encodeCursor(id: ResourceId): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): ResourceId | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded || encodeCursor(decoded) !== cursor) {
      throw new Error('non-canonical cursor');
    }
    return decoded;
  } catch {
    throw new ResourceConflictError(
      'Invalid resource query cursor',
      'INVALID_CURSOR',
    );
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function cloneResource(resource: ResourceDescriptor): ResourceDescriptor {
  return structuredClone(resource);
}

function cloneRelation(relation: ResourceRelation): ResourceRelation {
  return structuredClone(relation);
}

function cloneObservation(observation: ResourceObservation): ResourceObservation {
  return structuredClone(observation);
}

function cloneEvent(event: ResourceEvent): ResourceEvent {
  return structuredClone(event);
}

function cloneFact(fact: ResourceFact): ResourceFact {
  return structuredClone(fact);
}

function validateResourceContract(resource: ResourceDescriptor): void {
  try {
    assertResourceDescriptor(resource);
  } catch (error) {
    throw contractError(error);
  }
}

function validateRelationContract(relation: ResourceRelation): void {
  try {
    assertResourceRelation(relation);
  } catch (error) {
    throw contractError(error);
  }
}

function validateObservationContract(observation: ResourceObservation): void {
  try {
    assertResourceObservation(observation);
  } catch (error) {
    throw contractError(error);
  }
}

function validateChangeSetContract(changeSet: ResourceChangeSet): void {
  try {
    assertResourceChangeSet(changeSet);
  } catch (error) {
    throw contractError(error);
  }
}

function contractError(error: unknown): ResourceConflictError {
  if (error instanceof ContractValidationError) {
    return new ResourceConflictError(
      error.message,
      'RESOURCE_VALIDATION_FAILED',
    );
  }
  if (error instanceof ResourceConflictError) return error;
  return new ResourceConflictError(
    error instanceof Error ? error.message : String(error),
    'RESOURCE_VALIDATION_FAILED',
  );
}

function validateResourceSourceForRuntime(source: ResourceSource): void {
  const probe: ResourceDescriptor = {
    id: 'source-validation',
    kind: 'source-validation',
    nativeId: 'source-validation',
    canonicalName: 'source-validation',
    version: 1,
    firstSeenAt: source.observedAt,
    updatedAt: source.observedAt,
    sources: [source],
  };
  validateResourceContract(probe);
}

function emptyChangeResult(ignored: boolean): ResourceChangeResult {
  return {
    upsertedResources: 0,
    deletedResources: 0,
    restoredResources: 0,
    upsertedRelations: 0,
    deletedRelations: 0,
    observations: 0,
    ignored,
  };
}

function assertNoOverlap(left: string[], right: string[], message: string): void {
  const rightSet = new Set(right);
  if (left.some((item) => rightSet.has(item))) {
    throw new ResourceConflictError(message, 'RESOURCE_VALIDATION_FAILED');
  }
}

function normalizeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ResourceConflictError(
      `${name} must be a positive safe integer`,
      'RESOURCE_VALIDATION_FAILED',
    );
  }
  return value;
}

function requireIdentityPart(value: string, name: string): void {
  if (!value.trim()) {
    throw new ResourceConflictError(
      `${name} cannot be empty`,
      'RESOURCE_VALIDATION_FAILED',
    );
  }
}

function requireCanonicalTime(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new ResourceConflictError(
      `${name} must be a canonical ISO 8601 timestamp`,
      'RESOURCE_VALIDATION_FAILED',
    );
  }
  return value;
}

function laterTime(left: string, right: string): string {
  return left >= right ? left : right;
}

function laterOptionalTime(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return laterTime(left, right);
}

export function createResourceObservation(
  input: Omit<ResourceObservation, 'id'> & { id?: string },
): ResourceObservation {
  const observation = { ...input, id: input.id ?? randomUUID() };
  validateObservationContract(observation);
  return observation;
}
