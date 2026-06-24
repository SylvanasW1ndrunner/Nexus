import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SchemaRagDocument, SchemaRagGlossaryEntry, SchemaRagIndex } from './types.js';

const SNAPSHOT_VERSION = 1;

type PersistedSchemaRagSnapshot = {
  version: number;
  connectionId: string;
  savedAt: string;
  indexedAt: string;
  documents: SchemaRagDocument[];
  graph: Array<[string, string[]]>;
  glossary: SchemaRagGlossaryEntry[];
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
    };

    await writeFile(temp, `${JSON.stringify(snapshot)}\n`, 'utf8');
    await rename(temp, target);
  }

  async load(connectionId: string): Promise<SchemaRagIndex | undefined> {
    const target = this.snapshotPath(connectionId);
    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    try {
      return deserializeSnapshot(JSON.parse(raw), connectionId);
    } catch {
      return undefined;
    }
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
}

function deserializeSnapshot(value: unknown, expectedConnectionId: string): SchemaRagIndex | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== SNAPSHOT_VERSION) return undefined;
  if (value.connectionId !== expectedConnectionId) return undefined;
  if (typeof value.indexedAt !== 'string') return undefined;
  if (!Array.isArray(value.documents) || !Array.isArray(value.graph) || !Array.isArray(value.glossary)) {
    return undefined;
  }

  const documents = value.documents.filter(isSchemaRagDocument);
  if (documents.length !== value.documents.length) return undefined;

  const graph = new Map<string, Set<string>>();
  for (const entry of value.graph) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      return undefined;
    }
    graph.set(
      entry[0],
      new Set(
        entry[1].filter((relationId): relationId is string => typeof relationId === 'string' && relationId.length > 0),
      ),
    );
  }

  const glossary = value.glossary.filter(isSchemaRagGlossaryEntry);
  if (glossary.length !== value.glossary.length) return undefined;

  return {
    connectionId: expectedConnectionId,
    documents,
    graph,
    glossary,
    indexedAt: value.indexedAt,
  };
}

function isSchemaRagDocument(value: unknown): value is SchemaRagDocument {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.connectionId === 'string' &&
    (value.kind === 'table' || value.kind === 'column' || value.kind === 'relation') &&
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
