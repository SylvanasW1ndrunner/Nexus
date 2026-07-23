import type {
  ContractVersion,
  PortableValue,
} from './common.js';

export type ResourceId = string;
export type ResourceRelationId = string;

export type ResourceKind =
  | 'organization'
  | 'project'
  | 'environment'
  | 'platform'
  | 'account'
  | 'region'
  | 'cluster'
  | 'node'
  | 'shard'
  | 'replica'
  | 'compute-group'
  | 'storage-group'
  | 'catalog'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'external-table'
  | 'column'
  | 'partition'
  | 'index'
  | 'constraint'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'sequence'
  | 'role'
  | 'grant'
  | 'query'
  | 'job'
  | 'pipeline'
  | (string & {});

export type ResourceRelationKind =
  | 'contains'
  | 'runs_on'
  | 'replicates_to'
  | 'depends_on'
  | 'accessed_via'
  | 'owned_by'
  | 'member_of'
  | (string & {});

export type ResourceSource = {
  sourceId: string;
  sourceType: 'connector' | 'driver' | 'cloud-api' | 'mcp' | 'manual' | (string & {});
  connectorId?: string;
  connectionProfileId?: string;
  observedAt: string;
  expiresAt?: string;
  cursor?: string;
  priority?: number;
};

export type ResourceFact = {
  value: PortableValue;
  source: ResourceSource;
  confidence?: number;
};

export type ResolvedResourceFact = {
  key: string;
  selected?: ResourceFact;
  candidates: ResourceFact[];
  conflicted: boolean;
};

export type ResourceScope = {
  tenantId?: string;
  organizationId?: string;
  projectId?: string;
  environment?: string;
  region?: string;
};

export type ResourceDescriptor = {
  id: ResourceId;
  kind: ResourceKind;
  nativeId: string;
  canonicalName: string;
  displayName?: string;
  aliases?: string[];
  engine?: string;
  engineVersion?: string;
  scope?: ResourceScope;
  tags?: Record<string, string>;
  attributes?: Record<string, PortableValue>;
  facts?: Record<string, ResourceFact[]>;
  version: number;
  firstSeenAt: string;
  updatedAt: string;
  deletedAt?: string;
  sources: ResourceSource[];
};

export type ResourceRelation = {
  id: ResourceRelationId;
  kind: ResourceRelationKind;
  fromResourceId: ResourceId;
  toResourceId: ResourceId;
  attributes?: Record<string, PortableValue>;
  version: number;
  firstSeenAt: string;
  updatedAt: string;
  deletedAt?: string;
  sources: ResourceSource[];
};

export type ObservationStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unknown'
  | 'collecting'
  | (string & {});

export type ResourceObservation = {
  id: string;
  resourceId: ResourceId;
  category: string;
  status: ObservationStatus;
  metrics?: Record<string, number>;
  attributes?: Record<string, PortableValue>;
  observedAt: string;
  expiresAt: string;
  source: ResourceSource;
  collectionError?: {
    code: string;
    message: string;
  };
};

export type ResourceFreshness = 'fresh' | 'stale' | 'unknown';
export type ResourceLifecycle = 'active' | 'deleted';

export type ResourceCategoryState = {
  category: string;
  status: ObservationStatus;
  freshness: ResourceFreshness;
  observedAt?: string;
  expiresAt?: string;
  observationIds: string[];
  sourceIds: string[];
  conflicted: boolean;
};

export type ResourceStateSnapshot = {
  resourceId: ResourceId;
  asOf: string;
  lifecycle: ResourceLifecycle;
  status: ObservationStatus;
  freshness: ResourceFreshness;
  categories: ResourceCategoryState[];
  factConflicts: string[];
};

export type ResourceEventType =
  | 'resource-created'
  | 'resource-updated'
  | 'resource-deleted'
  | 'resource-restored'
  | 'resource-bound'
  | 'relation-created'
  | 'relation-updated'
  | 'relation-deleted'
  | 'observation-recorded'
  | 'change-set-applied';

export type ResourceEvent = {
  id: string;
  sequence: number;
  type: ResourceEventType;
  occurredAt: string;
  source: ResourceSource;
  resourceId?: ResourceId;
  relatedResourceId?: ResourceId;
  relationId?: ResourceRelationId;
  changedFields?: string[];
  attributes?: Record<string, PortableValue>;
};

export type ResourceDiscoveryPage = {
  resources: ResourceDescriptor[];
  relations: ResourceRelation[];
  observations?: ResourceObservation[];
  nextCursor?: string;
  snapshotId?: string;
  complete: boolean;
};

export type ResourceChangeSet = {
  sourceId: string;
  version: string;
  sequence?: number;
  observedAt: string;
  upsertResources?: ResourceDescriptor[];
  deleteResourceIds?: ResourceId[];
  restoreResourceIds?: ResourceId[];
  upsertRelations?: ResourceRelation[];
  deleteRelationIds?: ResourceRelationId[];
  observations?: ResourceObservation[];
};

export type ResourceQuery = {
  ids?: ResourceId[];
  kinds?: ResourceKind[];
  parentResourceId?: ResourceId;
  engine?: string;
  scope?: ResourceScope;
  text?: string;
  includeDeleted?: boolean;
  limit?: number;
  cursor?: string;
};

export type ResourceQueryPage = {
  items: ResourceDescriptor[];
  nextCursor?: string;
};

export type ResourceTraversalRequest = {
  startResourceIds: ResourceId[];
  direction?: 'outgoing' | 'incoming' | 'both';
  relationKinds?: ResourceRelationKind[];
  scope?: ResourceScope;
  includeDeleted?: boolean;
  maxDepth: number;
  maxResources: number;
};

export type ResourceTraversalNode = {
  resource: ResourceDescriptor;
  depth: number;
  viaRelationId?: ResourceRelationId;
};

export type ResourceTraversalResult = {
  nodes: ResourceTraversalNode[];
  relations: ResourceRelation[];
  truncated: boolean;
};

export type ResourceEventQuery = {
  resourceId?: ResourceId;
  types?: ResourceEventType[];
  afterSequence?: number;
  limit?: number;
};

export type ResourceEventPage = {
  items: ResourceEvent[];
  nextSequence?: number;
};

export type ResourceSourceVersion = {
  version: string;
  sequence?: number;
};

export type ResourceRegistrySnapshot = {
  contractVersion: ContractVersion;
  createdAt: string;
  resources: ResourceDescriptor[];
  relations: ResourceRelation[];
  observations: ResourceObservation[];
  events: ResourceEvent[];
  sourceVersions: Record<string, ResourceSourceVersion>;
  lastEventSequence: number;
};
