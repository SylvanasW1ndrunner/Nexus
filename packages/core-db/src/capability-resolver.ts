import type {
  CapabilityCheck,
  CapabilityConstraint,
  CapabilityDescriptor,
  CapabilityProfile,
  CapabilityRequirement,
  CapabilityStatus,
  DatabaseEngine,
  PortableValue,
} from '@dbagent/shared';

export const DATABASE_CAPABILITIES = {
  CONNECTION_POOLING: 'connection.pooling',
  CONNECTION_RECONNECT: 'connection.reconnect',
  CONNECTION_MULTI_ENDPOINT: 'connection.multi-endpoint',
  SQL_QUERY: 'sql.query',
  SQL_PARAMETERS: 'sql.parameters',
  SQL_WRITE: 'sql.write',
  SQL_DDL: 'sql.ddl',
  SQL_MULTI_STATEMENT: 'sql.multi-statement',
  TRANSACTION: 'transaction.basic',
  TRANSACTION_SAVEPOINT: 'transaction.savepoint',
  TRANSACTION_ISOLATION: 'transaction.isolation',
  QUERY_ASYNC: 'query.async',
  QUERY_PROGRESS: 'query.progress',
  QUERY_CANCEL: 'query.cancel',
  QUERY_RESULT_RESUME: 'query.result-resume',
  EXPLAIN: 'performance.explain',
  EXPLAIN_ANALYZE: 'performance.explain-analyze',
  DRY_RUN: 'performance.dry-run',
  METADATA_CATALOG: 'metadata.catalog',
  METADATA_SCHEMA: 'metadata.schema',
  METADATA_OBJECTS: 'metadata.objects',
  METADATA_PRIVILEGES: 'metadata.privileges',
  METADATA_DEPENDENCIES: 'metadata.dependencies',
  METADATA_INCREMENTAL: 'metadata.incremental',
  OBSERVE_SESSIONS: 'observe.sessions',
  OBSERVE_QUERIES: 'observe.queries',
  OBSERVE_LOCKS: 'observe.locks',
  OBSERVE_CAPACITY: 'observe.capacity',
  OBSERVE_REPLICATION: 'observe.replication',
  OPERATE_CANCEL_QUERY: 'operate.cancel-query',
  OPERATE_TERMINATE_SESSION: 'operate.terminate-session',
  OPERATE_ANALYZE: 'operate.analyze',
  OPERATE_VACUUM: 'operate.vacuum',
  RESULT_PAGINATION: 'result.pagination',
  RESULT_STREAMING: 'result.streaming',
  RESULT_ARROW: 'result.arrow',
  RESULT_DOWNLOAD: 'result.download',
} as const;

export const ALL_DATABASE_CAPABILITIES = Object.freeze(
  Object.values(DATABASE_CAPABILITIES),
);

export type CapabilityLayer = {
  source: string;
  capabilities: Record<string, Omit<CapabilityDescriptor, 'source' | 'observedAt'> & {
    observedAt?: string;
  }>;
};

export type CapabilityResolutionInput = {
  connectorId: string;
  engine: DatabaseEngine;
  engineVersion?: string;
  resourceId?: string;
  connectionProfileId?: string;
  layers: CapabilityLayer[];
  context?: Record<string, PortableValue>;
  resolvedAt?: string;
};

export class CapabilityResolver {
  resolve(input: CapabilityResolutionInput): CapabilityProfile {
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    const capabilities: Record<string, CapabilityDescriptor> = {};
    for (const layer of input.layers) {
      for (const [key, descriptor] of Object.entries(layer.capabilities)) {
        const normalized: CapabilityDescriptor = {
          ...descriptor,
          source: layer.source,
          observedAt: descriptor.observedAt ?? resolvedAt,
        };
        const check = checkConstraints(normalized.constraints ?? [], input.context);
        capabilities[key] = {
          ...normalized,
          ...(normalized.status === 'supported' && check.unmet.length > 0
            ? {
                status: 'conditional',
                reason: normalized.reason ?? 'Current context does not satisfy every capability constraint',
              }
            : {}),
        };
      }
    }
    return {
      connectorId: input.connectorId,
      engine: input.engine,
      resolvedAt,
      capabilities,
      ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.connectionProfileId ? { connectionProfileId: input.connectionProfileId } : {}),
    };
  }

  get(profile: CapabilityProfile, key: string): CapabilityDescriptor {
    return (
      profile.capabilities[key] ?? {
        key,
        status: 'unknown',
        reason: 'Connector did not declare this capability',
        source: 'implicit-unknown',
        observedAt: profile.resolvedAt,
      }
    );
  }

  check(
    profile: CapabilityProfile,
    requirement: CapabilityRequirement,
  ): CapabilityCheck {
    const capability = this.get(profile, requirement.key);
    const constraints = checkConstraints(capability.constraints ?? [], requirement.context);
    const conditionSatisfied =
      capability.status === 'conditional' &&
      (capability.constraints?.length ?? 0) > 0 &&
      constraints.unmet.length === 0;
    return {
      requirement,
      capability,
      satisfied:
        (capability.status === 'supported' || conditionSatisfied) &&
        constraints.unmet.length === 0,
      ...(constraints.unmet.length > 0 ? { unmetConstraints: constraints.unmet } : {}),
    };
  }

  require(
    profile: CapabilityProfile,
    requirement: CapabilityRequirement,
  ): CapabilityDescriptor {
    const result = this.check(profile, requirement);
    if (!result.satisfied) {
      const reason = result.capability.reason ?? result.capability.status;
      throw new CapabilityUnavailableError(requirement.key, result.capability.status, reason);
    }
    return result.capability;
  }
}

export class CapabilityUnavailableError extends Error {
  constructor(
    readonly capability: string,
    readonly status: CapabilityStatus,
    readonly reason: string,
  ) {
    super(`Capability ${capability} is ${status}: ${reason}`);
    this.name = 'CapabilityUnavailableError';
  }
}

function checkConstraints(
  constraints: CapabilityConstraint[],
  context: Record<string, PortableValue> | undefined,
): { unmet: CapabilityConstraint[] } {
  const unmet = constraints.filter((constraint) => {
    if (!context || !(constraint.name in context)) return true;
    const actual = context[constraint.name];
    return !matchesConstraint(actual, constraint);
  });
  return { unmet };
}

function matchesConstraint(actual: PortableValue | undefined, constraint: CapabilityConstraint): boolean {
  const operator = constraint.operator ?? 'eq';
  const expected = constraint.value;
  switch (operator) {
    case 'eq':
      return JSON.stringify(actual) === JSON.stringify(expected);
    case 'neq':
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case 'lt':
      return numeric(actual) < numeric(expected);
    case 'lte':
      return numeric(actual) <= numeric(expected);
    case 'gt':
      return numeric(actual) > numeric(expected);
    case 'gte':
      return numeric(actual) >= numeric(expected);
    case 'in':
      return Array.isArray(expected) && expected.some((item) => JSON.stringify(item) === JSON.stringify(actual));
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((item) => JSON.stringify(item) === JSON.stringify(expected))
        : typeof actual === 'string' && typeof expected === 'string'
          ? actual.includes(expected)
          : false;
  }
}

function numeric(value: PortableValue | undefined): number {
  return typeof value === 'number' ? value : Number.NaN;
}
