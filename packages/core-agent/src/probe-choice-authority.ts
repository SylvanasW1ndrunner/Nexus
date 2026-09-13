import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEY_BYTES = 32;
const MAX_REF_CHARS = 2_048;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export type ProbeChoiceOwner = Readonly<{
  hostId: string;
  projectId: string;
  sessionId: string;
  runId: string;
}>;

export type ProbeChoiceRecord = Readonly<{
  ref: string;
  providerId: string;
  candidateId: string;
  probeRevision: string;
  owner: ProbeChoiceOwner;
  expiresAt: string;
}>;

type UnsignedProbeChoiceRecord = Omit<ProbeChoiceRecord, 'ref'>;

/**
 * Runtime-only authority for opaque Capability choice references. The key is
 * durable Runtime state, never project configuration or model-visible data.
 */
export class ProjectProbeChoiceAuthority {
  #key: Promise<Buffer> | undefined;

  constructor(
    private readonly keyFilePath: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!keyFilePath.trim()) throw new TypeError('Probe choice key path is required.');
  }

  async issue(input: Readonly<{
    providerId: string;
    candidateId: string;
    probeRevision: string;
    owner: ProbeChoiceOwner;
    expiresAt?: string;
  }>): Promise<ProbeChoiceRecord> {
    const now = this.now();
    const expiresAt = input.expiresAt ?? new Date(now + MAX_LIFETIME_MS).toISOString();
    const record = normalizeRecord({
      providerId: input.providerId,
      candidateId: input.candidateId,
      probeRevision: input.probeRevision,
      owner: input.owner,
      expiresAt,
    });
    const expiry = Date.parse(record.expiresAt);
    if (expiry <= now || expiry - now > MAX_LIFETIME_MS) {
      throw new TypeError('Probe choice expiry is outside the Runtime lifetime bound.');
    }
    const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
    const signature = createHmac('sha256', await this.key()).update(payload).digest('base64url');
    const ref = `probe-choice.v1.${payload}.${signature}`;
    if (ref.length > MAX_REF_CHARS) throw new TypeError('Probe choice reference exceeds its bound.');
    return Object.freeze({ ref, ...record });
  }

  async verify(ref: string, owner: ProbeChoiceOwner): Promise<ProbeChoiceRecord> {
    if (!ref.startsWith('probe-choice.v1.') || ref.length > MAX_REF_CHARS) {
      throw new TypeError('Probe choice reference is invalid.');
    }
    const parts = ref.split('.');
    if (parts.length !== 4) throw new TypeError('Probe choice reference is invalid.');
    const payload = parts[2]!;
    const supplied = Buffer.from(parts[3]!, 'base64url');
    const expected = createHmac('sha256', await this.key()).update(payload).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new TypeError('Probe choice reference signature is invalid.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new TypeError('Probe choice reference payload is invalid.');
    }
    const record = normalizeRecord(parsed);
    if (!sameOwner(record.owner, normalizeOwner(owner))) {
      throw new TypeError('Probe choice reference belongs to another Runtime owner.');
    }
    if (Date.parse(record.expiresAt) <= this.now()) {
      throw new TypeError('Probe choice reference expired; probe again.');
    }
    return Object.freeze({ ref, ...record });
  }

  private key(): Promise<Buffer> {
    return this.#key ??= loadOrCreateKey(this.keyFilePath);
  }
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // A hard-link publication is atomic and refuses to replace a key created
      // by another Runtime process. The final path is never partially written.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError('Probe choice authority key must be a regular file.');
  }
  const key = await readFile(path);
  if (key.length !== KEY_BYTES) throw new TypeError('Probe choice authority key has an invalid size.');
  return key;
}

function normalizeRecord(value: unknown): UnsignedProbeChoiceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Probe choice record must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = ['providerId', 'candidateId', 'probeRevision', 'owner', 'expiresAt'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError('Probe choice record shape is invalid.');
  }
  const expiresAt = text(record.expiresAt, 'expiresAt', 64);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError('Probe choice expiry is invalid.');
  return Object.freeze({
    providerId: text(record.providerId, 'providerId', 256),
    candidateId: text(record.candidateId, 'candidateId', 256),
    probeRevision: text(record.probeRevision, 'probeRevision', 256),
    owner: normalizeOwner(record.owner),
    expiresAt,
  });
}

function normalizeOwner(value: unknown): ProbeChoiceOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Probe choice owner must be an object.');
  }
  const owner = value as Record<string, unknown>;
  const keys = ['hostId', 'projectId', 'sessionId', 'runId'];
  if (Object.keys(owner).length !== keys.length || keys.some((key) => !Object.hasOwn(owner, key))) {
    throw new TypeError('Probe choice owner shape is invalid.');
  }
  return Object.freeze({
    hostId: text(owner.hostId, 'owner.hostId', 512),
    projectId: text(owner.projectId, 'owner.projectId', 512),
    sessionId: text(owner.sessionId, 'owner.sessionId', 512),
    runId: text(owner.runId, 'owner.runId', 512),
  });
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new TypeError(`Probe choice ${label} is invalid.`);
  }
  return value.trim();
}

function sameOwner(left: ProbeChoiceOwner, right: ProbeChoiceOwner): boolean {
  return left.hostId === right.hostId && left.projectId === right.projectId &&
    left.sessionId === right.sessionId && left.runId === right.runId;
}
