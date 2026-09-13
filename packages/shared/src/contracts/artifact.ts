import type { ResultHandle } from './database.js';

/** Public availability state. Storage paths and implementation metadata never cross this boundary. */
export type ContentAvailability =
  | 'staged'
  | 'available'
  | 'expired'
  | 'deleted'
  | 'corrupt'
  | 'legacy-unavailable';

/** Portable reference to a complete exported artifact. */
export type ArtifactRef = {
  schemaVersion: 1;
  artifactId: string;
  handle: string;
  projectId: string;
  checksum: string;
  byteSize: number;
  mediaType: string;
  availability: 'available';
  createdAt: string;
  expiresAt?: string;
};

/**
 * Durable form of the existing ResultHandle contract. It is a strict extension,
 * so consumers that only understand ResultHandle remain source compatible.
 */
export type DurableResultHandle = ResultHandle & {
  schemaVersion: 1;
  scheme: 'schemanaut.database-result';
  projectId: string;
  checksum: string;
  availability: 'available';
  createdAt: string;
};
