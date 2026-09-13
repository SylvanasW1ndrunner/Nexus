import type { StagedArtifact, ArtifactRef, ArtifactIoContext } from '../artifacts/artifact-store.js';
import type { AgentEvent } from '../events/agent-event.js';

type ArtifactCreatedPayload = Extract<AgentEvent, { type: 'artifact.created' }>['payload'];

export type PreparedToolArtifactCommit = Readonly<{
  /** Opaque package-internal capability. Its authority lives in this module's WeakMap. */
  readonly preparedToolArtifact: true;
}>;

export type PrepareToolArtifactInput = Readonly<{
  staged: StagedArtifact;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  startedAttempt: number;
  idempotencyKey: string;
  fencingToken: number;
  summary: string;
  signal?: AbortSignal;
  deadline?: string;
}>;

export type PreparedToolArtifactRecord = Readonly<{
  owner: object;
  journalOwner: object;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  startedAttempt: number;
  idempotencyKey: string;
  fencingToken: number;
  staged: StagedArtifact;
  context: ArtifactIoContext;
  payload: Extract<ArtifactCreatedPayload, { availability: 'available' }>;
  lifecycle: {
    released: boolean;
    draining?: boolean;
    release: () => void;
  };
}>;

export type ToolArtifactCommitter = Readonly<{
  journalOwner: object;
  prepare(input: PrepareToolArtifactInput): Promise<PreparedToolArtifactCommit>;
  complete(prepared: PreparedToolArtifactCommit): Promise<ArtifactRef>;
  release(prepared: PreparedToolArtifactCommit): void;
}>;

const preparedArtifacts = new WeakMap<object, PreparedToolArtifactRecord>();
const artifactCommitters = new WeakMap<object, ToolArtifactCommitter>();

export function bindToolArtifactCommitter(
  store: object,
  committer: ToolArtifactCommitter,
): void {
  if (artifactCommitters.has(store)) {
    throw new TypeError('Tool Artifact authority is already bound to this Artifact Store.');
  }
  artifactCommitters.set(store, Object.freeze(committer));
}

export function openToolArtifactCommitter(store: object): ToolArtifactCommitter {
  const committer = artifactCommitters.get(store);
  if (committer === undefined) {
    throw new TypeError('Artifact Store is not bound to the Tool Artifact authority.');
  }
  return committer;
}

export function mintPreparedToolArtifact(
  record: PreparedToolArtifactRecord,
): PreparedToolArtifactCommit {
  const capability: PreparedToolArtifactCommit = {
    preparedToolArtifact: true,
  };
  Object.setPrototypeOf(capability, null);
  Object.freeze(capability);
  preparedArtifacts.set(capability, Object.freeze({
    ...record,
    staged: Object.freeze(structuredClone(record.staged)),
    payload: Object.freeze(structuredClone(record.payload)),
  }));
  return capability;
}

export function inspectPreparedToolArtifact(
  capability: PreparedToolArtifactCommit,
): PreparedToolArtifactRecord {
  const record = preparedArtifacts.get(capability);
  if (record === undefined) {
    throw new TypeError('Prepared Tool Artifact capability is not authentic.');
  }
  return record;
}
