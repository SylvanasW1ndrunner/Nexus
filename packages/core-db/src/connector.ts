import type {
  CapabilityDescriptor,
  CapabilityProfile,
  ConnectionHealth,
  ConnectionProfile,
  ConnectionSession,
  ConnectionTestResult,
  DatabaseCredential,
  DatabaseEndpoint,
  DatabaseObservationRequest,
  DatabaseOperationDescriptor,
  DatabaseOperationRequest,
  DatabaseOperationResult,
  DatabaseTransaction,
  QueryJob,
  QuerySubmission,
  ResourceDiscoveryPage,
  ResourceObservation,
  ResultBatch,
  SqlDialectDescriptor,
  TransactionIsolationLevel,
} from '@dbagent/shared';

export type ConnectorTransport = DatabaseEndpoint['transport'];

export type ConnectorManifest = {
  id: string;
  displayName: string;
  version: string;
  engine: string;
  transports: ConnectorTransport[];
  execution: 'synchronous' | 'asynchronous' | 'hybrid';
  dialect?: SqlDialectDescriptor;
  capabilities: Record<string, CapabilityDescriptor>;
  operations: DatabaseOperationDescriptor[];
  verifiedAgainst?: Array<{
    engineVersion?: string;
    protocolVersion?: string;
    verifiedAt: string;
    scope: 'contract' | 'vendor';
  }>;
};

export type ConnectorContext = {
  profile: ConnectionProfile;
  credential?: DatabaseCredential;
  session?: ConnectionSession;
};

export type DiscoveryRequest = {
  cursor?: string;
  limit?: number;
  kinds?: string[];
  incrementalSince?: string;
};

export type TransactionOptions = {
  isolationLevel?: TransactionIsolationLevel;
  readOnly?: boolean;
};

export interface DatabaseConnector {
  readonly manifest: ConnectorManifest;
  test(context: ConnectorContext): Promise<ConnectionTestResult>;
  connect(context: ConnectorContext): Promise<ConnectionSession>;
  disconnect(context: ConnectorContext): Promise<void>;
  reconnect?(context: ConnectorContext): Promise<ConnectionSession>;
  health(context: ConnectorContext): Promise<ConnectionHealth>;
  capabilities(context: ConnectorContext): Promise<CapabilityProfile>;
  discover(context: ConnectorContext, request: DiscoveryRequest): Promise<ResourceDiscoveryPage>;
  submit(context: ConnectorContext, submission: QuerySubmission): Promise<QueryJob>;
  getJob(context: ConnectorContext, jobId: string): Promise<QueryJob>;
  cancel(context: ConnectorContext, jobId: string): Promise<QueryJob>;
  readResult(
    context: ConnectorContext,
    handleId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<ResultBatch>;
  releaseResult?(context: ConnectorContext, handleId: string): Promise<boolean>;
  streamResult?(
    context: ConnectorContext,
    handleId: string,
    input?: { batchSize?: number },
  ): AsyncIterable<ResultBatch>;
  beginTransaction?(
    context: ConnectorContext,
    options?: TransactionOptions,
  ): Promise<DatabaseTransaction>;
  createSavepoint?(context: ConnectorContext, transactionId: string, name: string): Promise<DatabaseTransaction>;
  rollbackToSavepoint?(
    context: ConnectorContext,
    transactionId: string,
    name: string,
  ): Promise<DatabaseTransaction>;
  commitTransaction?(context: ConnectorContext, transactionId: string): Promise<DatabaseTransaction>;
  rollbackTransaction?(context: ConnectorContext, transactionId: string): Promise<DatabaseTransaction>;
  observe?(
    context: ConnectorContext,
    request: DatabaseObservationRequest,
  ): Promise<ResourceObservation[]>;
  operate?(
    context: ConnectorContext,
    request: DatabaseOperationRequest,
  ): Promise<DatabaseOperationResult>;
}

export type ConnectorCapabilityOverrides = Record<
  string,
  Pick<CapabilityDescriptor, 'status'> &
    Partial<Omit<CapabilityDescriptor, 'key' | 'status' | 'source' | 'observedAt'>>
>;
