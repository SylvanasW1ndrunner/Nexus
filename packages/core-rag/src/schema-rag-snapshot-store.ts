import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyKnowledgeCatalog } from './merkle-catalog.js';
import type {
  KnowledgeCatalog,
  SchemaRagDocument,
  SchemaRagGlossaryEntry,
  SchemaRagIndex,
  SchemaRagIndexManifest,
  SchemaRagRetrievalProfile,
} from './types.js';

const SNAPSHOT_VERSION = 2;

type PersistedSchemaRagSnapshot = {
  version: number;
  connectionId: string;
  savedAt: string;
  indexedAt: string;
  documents: SchemaRagDocument[];
  graph: Array<[string, string[]]>;
  glossary: SchemaRagGlossaryEntry[];
  catalog?: KnowledgeCatalog;
  manifest?: SchemaRagIndexManifest;
  retrievalProfile?: SchemaRagRetrievalProfile;
  vectors?: Record<string, number[]>;
};

export type SchemaRagSnapshotLoadResult =
  | {
      status: 'loaded';
      snapshotPath: string;
      index: SchemaRagIndex;
    }
  | {
      status: 'missing';
      snapshotPath: string;
    }
  | {
      status: 'invalid';
      snapshotPath: string;
      reason: string;
      quarantinedPath?: string;
      quarantineError?: string;
    }
  | {
      status: 'error';
      snapshotPath: string;
      error: unknown;
    };

export type SchemaRagSnapshotSummary =
  | {
      status: 'available';
      connectionId: string;
      snapshotPath: string;
      savedAt: string;
      indexedAt: string;
      documentCount: number;
      tableCount: number;
      columnCount: number;
      relationCount: number;
      glossaryCount: number;
    }
  | {
      status: 'invalid';
      snapshotPath: string;
      reason: string;
    };

export type SchemaRagSnapshotCleanupResult = {
  kept: SchemaRagSnapshotSummary[];
  removed: Array<{
    snapshotPath: string;
    reason: 'inactive_connection' | 'invalid_snapshot';
    connectionId?: string;
  }>;
};

export type SchemaRagSnapshotStoreOptions = {
  rootDir: string;
};

export class SchemaRagSnapshotStore {
  private readonly rootDir: string;

  constructor(options: SchemaRagSnapshotStoreOptions) {
    if (!options.rootDir.trim()) {
      throw new Error('Schema RAG snapshot rootDir is required.');
    }
    this.rootDir = path.resolve(options.rootDir);
  }

  async save(index: SchemaRagIndex): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.snapshotPath(index.connectionId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const snapshot: PersistedSchemaRagSnapshot = {
      version: SNAPSHOT_VERSION,
      connectionId: index.connectionId,
      savedAt: new Date().toISOString(),
      indexedAt: index.indexedAt,
      documents: index.documents,
      graph: [...index.graph.entries()].map(([id, relationIds]) => [id, [...relationIds]]),
      glossary: index.glossary,
      ...(index.catalog === undefined ? {} : { catalog: index.catalog }),
      ...(index.manifest === undefined ? {} : { manifest: index.manifest }),
      ...(index.retrievalProfile === undefined
        ? {}
        : { retrievalProfile: index.retrievalProfile }),
      ...(index.vectors === undefined ? {} : { vectors: index.vectors }),
    };

    await writeFile(temp, `${JSON.stringify(snapshot)}\n`, 'utf8');
    await rename(temp, target);
  }

  async load(connectionId: string): Promise<SchemaRagIndex | undefined> {
    const result = await this.loadDetailed(connectionId);
    if (result.status === 'loaded') return result.index;
    if (result.status === 'error') throw result.error;
    return undefined;
  }

  async loadDetailed(connectionId: string): Promise<SchemaRagSnapshotLoadResult> {
    const target = this.snapshotPath(connectionId);
    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { status: 'missing', snapshotPath: target };
      return { status: 'error', snapshotPath: target, error };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return this.invalidSnapshotResult(target, error instanceof Error ? error.message : 'Snapshot JSON is invalid.');
    }

    const deserialized = deserializeSnapshot(parsed, connectionId);
    if (deserialized.status === 'invalid') return this.invalidSnapshotResult(target, deserialized.reason);
    return { status: 'loaded', snapshotPath: target, index: deserialized.index };
  }

  async list(): Promise<SchemaRagSnapshotSummary[]> {
    const files = await this.snapshotFiles();
    const summaries: SchemaRagSnapshotSummary[] = [];
    for (const file of files) {
      const snapshotPath = path.join(this.rootDir, file);
      summaries.push(await readSnapshotSummary(snapshotPath));
    }
    return summaries.sort(compareSnapshotSummary);
  }

  async cleanupInactive(input: {
    activeConnectionIds: Iterable<string>;
    removeInvalid?: boolean;
  }): Promise<SchemaRagSnapshotCleanupResult> {
    const activeConnectionIds = new Set(
      [...input.activeConnectionIds].map((connectionId) => validateConnectionId(connectionId)),
    );
    const summaries = await this.list();
    const kept: SchemaRagSnapshotSummary[] = [];
    const removed: SchemaRagSnapshotCleanupResult['removed'] = [];

    for (const summary of summaries) {
      if (summary.status === 'invalid') {
        if (input.removeInvalid === true) {
          await rm(summary.snapshotPath, { force: true });
          removed.push({ snapshotPath: summary.snapshotPath, reason: 'invalid_snapshot' });
        } else {
          kept.push(summary);
        }
        continue;
      }

      if (!activeConnectionIds.has(summary.connectionId)) {
        await rm(summary.snapshotPath, { force: true });
        removed.push({
          snapshotPath: summary.snapshotPath,
          reason: 'inactive_connection',
          connectionId: summary.connectionId,
        });
        continue;
      }

      kept.push(summary);
    }

    return { kept, removed };
  }

  async remove(connectionId: string): Promise<void> {
    try {
      await rm(this.snapshotPath(connectionId), { force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  getSnapshotPath(connectionId: string): string {
    return this.snapshotPath(connectionId);
  }

  private snapshotPath(connectionId: string): string {
    const safeName = encodeURIComponent(validateConnectionId(connectionId)).replace(/%/g, '_');
    return path.join(this.rootDir, `${safeName}.schema-rag.json`);
  }

  private async snapshotFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.schema-rag.json'))
        .map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async invalidSnapshotResult(target: string, reason: string): Promise<SchemaRagSnapshotLoadResult> {
    const result: SchemaRagSnapshotLoadResult = { status: 'invalid', snapshotPath: target, reason };
    try {
      const quarantinedPath = `${target}.corrupt-${Date.now()}`;
      await rename(target, quarantinedPath);
      return { ...result, quarantinedPath };
    } catch (error) {
      if (isNotFound(error)) return result;
      return { ...result, quarantineError: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function readSnapshotSummary(snapshotPath: string): Promise<SchemaRagSnapshotSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch (error) {
    return {
      status: 'invalid',
      snapshotPath,
      reason: error instanceof Error ? error.message : 'Snapshot JSON is invalid.',
    };
  }

  const result = deserializeSnapshotForSummary(parsed);
  return result.status === 'available' ? { ...result.summary, snapshotPath } : { ...result, snapshotPath };
}

type SnapshotSummaryDeserializeResult =
  | {
      status: 'available';
      summary: Omit<Extract<SchemaRagSnapshotSummary, { status: 'available' }>, 'snapshotPath'>;
    }
  | {
      status: 'invalid';
      reason: string;
    };

function deserializeSnapshotForSummary(value: unknown): SnapshotSummaryDeserializeResult {
  if (!isRecord(value)) return { status: 'invalid', reason: 'Snapshot root must be an object.' };
  if (value.version !== SNAPSHOT_VERSION) {
    return { status: 'invalid', reason: `Unsupported snapshot version: ${String(value.version)}.` };
  }
  if (typeof value.connectionId !== 'string' || !value.connectionId.trim()) {
    return { status: 'invalid', reason: 'Snapshot connection id is missing or invalid.' };
  }
  if (typeof value.savedAt !== 'string') return { status: 'invalid', reason: 'Snapshot savedAt is missing or invalid.' };
  if (typeof value.indexedAt !== 'string') {
    return { status: 'invalid', reason: 'Snapshot indexedAt is missing or invalid.' };
  }
  if (!Array.isArray(value.documents) || !Array.isArray(value.graph) || !Array.isArray(value.glossary)) {
    return { status: 'invalid', reason: 'Snapshot documents, graph, or glossary section is missing.' };
  }

  const documents = value.documents.filter(isSchemaRagDocument);
  if (documents.length !== value.documents.length) {
    return { status: 'invalid', reason: 'Snapshot contains invalid schema documents.' };
  }
  const glossary = value.glossary.filter(isSchemaRagGlossaryEntry);
  if (glossary.length !== value.glossary.length) {
    return { status: 'invalid', reason: 'Snapshot contains invalid glossary entries.' };
  }

  return {
    status: 'available',
    summary: {
      status: 'available',
      connectionId: value.connectionId,
      savedAt: value.savedAt,
      indexedAt: value.indexedAt,
      documentCount: documents.length,
      tableCount: documents.filter((document) => document.kind === 'table').length,
      columnCount: documents.filter((document) => document.kind === 'column').length,
      relationCount: documents.filter((document) => document.kind === 'relation').length,
      glossaryCount: glossary.length,
    },
  };
}

function compareSnapshotSummary(left: SchemaRagSnapshotSummary, right: SchemaRagSnapshotSummary): number {
  const leftKey = left.status === 'available' ? left.connectionId : left.snapshotPath;
  const rightKey = right.status === 'available' ? right.connectionId : right.snapshotPath;
  return leftKey.localeCompare(rightKey);
}

type DeserializeSnapshotResult =
  | {
      status: 'loaded';
      index: SchemaRagIndex;
    }
  | {
      status: 'invalid';
      reason: string;
    };

function deserializeSnapshot(value: unknown, expectedConnectionId: string): DeserializeSnapshotResult {
  if (!isRecord(value)) return invalidSnapshot('Snapshot root must be an object.');
  if (value.version !== SNAPSHOT_VERSION) return invalidSnapshot(`Unsupported snapshot version: ${String(value.version)}.`);
  if (value.connectionId !== expectedConnectionId) return invalidSnapshot('Snapshot connection id does not match the requested connection.');
  if (typeof value.indexedAt !== 'string') return invalidSnapshot('Snapshot indexedAt is missing or invalid.');
  if (!Array.isArray(value.documents) || !Array.isArray(value.graph) || !Array.isArray(value.glossary)) {
    return invalidSnapshot('Snapshot documents, graph, or glossary section is missing.');
  }

  const documents = value.documents.filter(isSchemaRagDocument);
  if (documents.length !== value.documents.length) return invalidSnapshot('Snapshot contains invalid schema documents.');

  const graph = new Map<string, Set<string>>();
  for (const entry of value.graph) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      return invalidSnapshot('Snapshot contains invalid graph edges.');
    }
    graph.set(
      entry[0],
      new Set(
        entry[1].filter((relationId): relationId is string => typeof relationId === 'string' && relationId.length > 0),
      ),
    );
  }

  const glossary = value.glossary.filter(isSchemaRagGlossaryEntry);
  if (glossary.length !== value.glossary.length) return invalidSnapshot('Snapshot contains invalid glossary entries.');
  if (
    value.catalog !== undefined &&
    !isKnowledgeCatalog(value.catalog, expectedConnectionId)
  ) {
    return invalidSnapshot('Snapshot contains an invalid knowledge catalog.');
  }
  if (
    value.manifest !== undefined &&
    !isSchemaRagIndexManifest(value.manifest, expectedConnectionId)
  ) {
    return invalidSnapshot('Snapshot contains an invalid index manifest.');
  }
  if (
    value.retrievalProfile !== undefined &&
    !isRetrievalProfile(value.retrievalProfile)
  ) {
    return invalidSnapshot('Snapshot contains an invalid retrieval profile.');
  }
  if (value.vectors !== undefined && !isVectorRecord(value.vectors)) {
    return invalidSnapshot('Snapshot contains invalid embedding vectors.');
  }
  if (
    isKnowledgeCatalog(value.catalog, expectedConnectionId) &&
    isSchemaRagIndexManifest(value.manifest, expectedConnectionId) &&
    value.manifest.catalogRootHash !== value.catalog.catalogRootHash
  ) {
    return invalidSnapshot('Snapshot index manifest does not match the knowledge catalog.');
  }

  return {
    status: 'loaded',
    index: {
      connectionId: expectedConnectionId,
      documents,
      graph,
      glossary,
      ...(isKnowledgeCatalog(value.catalog, expectedConnectionId)
        ? { catalog: value.catalog }
        : {}),
      ...(isSchemaRagIndexManifest(value.manifest, expectedConnectionId)
        ? { manifest: value.manifest }
        : {}),
      ...(isRetrievalProfile(value.retrievalProfile)
        ? { retrievalProfile: value.retrievalProfile }
        : {}),
      ...(isVectorRecord(value.vectors) ? { vectors: value.vectors } : {}),
      indexedAt: value.indexedAt,
    },
  };
}

function invalidSnapshot(reason: string): DeserializeSnapshotResult {
  return { status: 'invalid', reason };
}

function isSchemaRagDocument(value: unknown): value is SchemaRagDocument {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.connectionId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.title === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.tokens) &&
    value.tokens.every((token) => typeof token === 'string') &&
    Array.isArray(value.relationIds) &&
    value.relationIds.every((relationId) => typeof relationId === 'string') &&
    isRecord(value.metadata)
  );
}

function isKnowledgeCatalog(
  value: unknown,
  connectionId: string,
): value is KnowledgeCatalog {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.connectionId !== connectionId ||
    !Array.isArray(value.rootIds) ||
    !isRecord(value.nodes) ||
    !isRecord(value.relations) ||
    !isRecord(value.knowledge) ||
    !isRecord(value.bindings) ||
    typeof value.catalogRootHash !== 'string' ||
    typeof value.snapshotId !== 'string' ||
    typeof value.builtAt !== 'string'
  ) {
    return false;
  }
  try {
    return verifyKnowledgeCatalog(value as KnowledgeCatalog).valid;
  } catch {
    return false;
  }
}

function isSchemaRagIndexManifest(
  value: unknown,
  connectionId: string,
): value is SchemaRagIndexManifest {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.connectionId === connectionId &&
    typeof value.catalogRootHash === 'string' &&
    typeof value.retrievalProfileId === 'string' &&
    typeof value.retrievalProfileVersion === 'number' &&
    typeof value.documentCount === 'number' &&
    typeof value.indexVersion === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.sourceTableCount === undefined ||
      (typeof value.sourceTableCount === 'number' &&
        Number.isInteger(value.sourceTableCount) &&
        value.sourceTableCount >= 0)) &&
    (value.maxTables === undefined ||
      (typeof value.maxTables === 'number' &&
        Number.isInteger(value.maxTables) &&
        value.maxTables > 0))
  );
}

function isVectorRecord(value: unknown): value is Record<string, number[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length > 0 &&
        vector.every((item) => typeof item === 'number' && Number.isFinite(item)),
    )
  );
}

function isRetrievalProfile(value: unknown): value is SchemaRagRetrievalProfile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'number' &&
    isRecord(value.backend) &&
    typeof value.backend.type === 'string'
  );
}

function isSchemaRagGlossaryEntry(value: unknown): value is SchemaRagGlossaryEntry {
  return (
    isRecord(value) &&
    typeof value.term === 'string' &&
    Array.isArray(value.documentIds) &&
    value.documentIds.every((documentId) => typeof documentId === 'string') &&
    (value.aliases === undefined ||
      (Array.isArray(value.aliases) && value.aliases.every((alias) => typeof alias === 'string'))) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.weight === undefined || typeof value.weight === 'number')
  );
}

function validateConnectionId(connectionId: string): string {
  const trimmed = connectionId.trim();
  if (!trimmed) throw new Error('Schema RAG snapshot connectionId is required.');
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
