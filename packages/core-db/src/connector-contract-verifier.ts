import type {
  ConnectionProfile,
  DatabaseCredential,
  QueryJob,
  QuerySubmission,
} from '@dbagent/shared';
import { ALL_DATABASE_CAPABILITIES } from './capability-resolver.js';
import type { ConnectorContext, DatabaseConnector } from './connector.js';

export type ConnectorContractCheck = {
  name: string;
  passed: boolean;
  elapsedMs: number;
  detail?: string;
};

export type ConnectorCertificationReport = {
  connectorId: string;
  connectorVersion: string;
  engine: string;
  scope: 'contract' | 'vendor';
  passed: boolean;
  verifiedAt: string;
  checks: ConnectorContractCheck[];
};

export type ConnectorContractVerificationOptions = {
  connector: DatabaseConnector;
  profile: ConnectionProfile;
  credential?: DatabaseCredential;
  readQuery: Omit<QuerySubmission, 'profileId'>;
  scope?: 'contract' | 'vendor';
  maximumDiscoveryPages?: number;
  jobTimeoutMs?: number;
};

/**
 * Reusable, read-only connector contract verification. A passing `contract`
 * report proves that the adapter obeys SchemaNaut contracts; only a run against
 * the actual vendor service may use `scope: "vendor"`.
 */
export async function verifyConnectorContract(
  options: ConnectorContractVerificationOptions,
): Promise<ConnectorCertificationReport> {
  const checks: ConnectorContractCheck[] = [];
  const baseContext: ConnectorContext = {
    profile: structuredClone(options.profile),
    ...(options.credential ? { credential: structuredClone(options.credential) } : {}),
  };
  let context = baseContext;
  let connected = false;

  await check(checks, 'manifest', () => {
    const { manifest } = options.connector;
    if (!manifest.id || !manifest.version || !manifest.engine || manifest.transports.length === 0) {
      throw new Error('Manifest identity, version, engine and transports are required');
    }
    if (manifest.engine !== options.profile.engine) {
      throw new Error('Manifest engine does not match the verification profile');
    }
    if (!options.profile.endpoints.every((endpoint) => manifest.transports.includes(endpoint.transport))) {
      throw new Error('Profile uses a transport not declared by the connector');
    }
  });

  await check(checks, 'capability-coverage', () => {
    const missing = ALL_DATABASE_CAPABILITIES.filter(
      (key) => !options.connector.manifest.capabilities[key],
    );
    if (missing.length > 0) throw new Error(`Missing explicit capability states: ${missing.join(', ')}`);
    for (const [key, capability] of Object.entries(options.connector.manifest.capabilities)) {
      if (capability.key !== key) throw new Error(`Capability key mismatch: ${key}`);
      if (!['supported', 'conditional', 'unsupported', 'unknown'].includes(capability.status)) {
        throw new Error(`Invalid capability state: ${key}`);
      }
    }
  });

  await check(checks, 'connection-test', async () => {
    const result = await options.connector.test(baseContext);
    if (result.status === 'unavailable') throw new Error(result.message ?? 'Connection unavailable');
    if (result.connectorId !== options.connector.manifest.id) {
      throw new Error('Connection test returned a different connector id');
    }
  });

  await check(checks, 'connect', async () => {
    const session = await options.connector.connect(baseContext);
    if (session.status !== 'connected') throw new Error(`Unexpected session state: ${session.status}`);
    if (session.profileId !== options.profile.id) throw new Error('Session profile id mismatch');
    context = { ...baseContext, session };
    connected = true;
  });

  if (connected) {
    await check(checks, 'health', async () => {
      const health = await options.connector.health(context);
      if (!health.checkedAt || health.status === 'unknown') {
        throw new Error('Connected health must be timestamped and identifiable');
      }
    });

    await check(checks, 'dynamic-capabilities', async () => {
      const profile = await options.connector.capabilities(context);
      if (profile.connectorId !== options.connector.manifest.id) {
        throw new Error('Dynamic capability connector id mismatch');
      }
      const missing = ALL_DATABASE_CAPABILITIES.filter((key) => !profile.capabilities[key]);
      if (missing.length > 0) {
        throw new Error(`Dynamic profile omitted capabilities: ${missing.join(', ')}`);
      }
    });

    await check(checks, 'paged-discovery', async () => {
      const knownResources = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await options.connector.discover(context, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        pages += 1;
        for (const resource of page.resources) {
          if (!resource.sources.length || !resource.updatedAt) {
            throw new Error(`Resource ${resource.id} has no provenance or timestamp`);
          }
          knownResources.add(resource.id);
        }
        for (const relation of page.relations) {
          if (
            !knownResources.has(relation.fromResourceId) ||
            !knownResources.has(relation.toResourceId)
          ) {
            throw new Error(`Relation ${relation.id} references an undiscovered resource`);
          }
        }
        if (page.complete) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) {
          throw new Error('Incomplete discovery returned a missing or repeated cursor');
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (pages >= (options.maximumDiscoveryPages ?? 1_000)) {
          throw new Error('Discovery exceeded its page limit');
        }
      } while (cursor);
    });

    await check(checks, 'query-job-and-results', async () => {
      let job = await options.connector.submit(context, {
        ...structuredClone(options.readQuery),
        profileId: options.profile.id,
      });
      job = await waitForTerminal(
        options.connector,
        context,
        job,
        options.jobTimeoutMs ?? 10_000,
      );
      if (job.state !== 'succeeded') {
        throw new Error(`Read query stopped at ${job.state}: ${job.error?.message ?? ''}`);
      }
      if (!job.result) throw new Error('Successful query did not return a result handle');
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const batch = await options.connector.readResult(context, job.result.id, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        if (batch.handleId !== job.result.id || batch.rowOffset < 0) {
          throw new Error('Result batch identity or offset is invalid');
        }
        if (batch.complete) break;
        if (!batch.nextCursor || seenCursors.has(batch.nextCursor)) {
          throw new Error('Incomplete result returned a missing or repeated cursor');
        }
        seenCursors.add(batch.nextCursor);
        cursor = batch.nextCursor;
      } while (cursor);
    });
  }

  if (connected) {
    await check(checks, 'disconnect', async () => {
      await options.connector.disconnect(context);
      connected = false;
    });
  }

  if (connected) {
    try {
      await options.connector.disconnect(context);
    } catch {
      // The failed disconnect is already represented by a contract check.
    }
  }

  return {
    connectorId: options.connector.manifest.id,
    connectorVersion: options.connector.manifest.version,
    engine: options.connector.manifest.engine,
    scope: options.scope ?? 'contract',
    passed: checks.every((item) => item.passed),
    verifiedAt: new Date().toISOString(),
    checks,
  };
}

async function check(
  checks: ConnectorContractCheck[],
  name: string,
  operation: () => void | Promise<void>,
): Promise<void> {
  const started = performance.now();
  try {
    await operation();
    checks.push({ name, passed: true, elapsedMs: performance.now() - started });
  } catch (error) {
    checks.push({
      name,
      passed: false,
      elapsedMs: performance.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForTerminal(
  connector: DatabaseConnector,
  context: ConnectorContext,
  initial: QueryJob,
  timeoutMs: number,
): Promise<QueryJob> {
  let job = initial;
  const deadline = Date.now() + timeoutMs;
  while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state)) {
    if (Date.now() >= deadline) throw new Error(`Query job timed out at ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await connector.getJob(context, job.id);
  }
  return job;
}
