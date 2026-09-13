import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { mkdir as nodeMkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentArtifactStore, ContentOpenRequest, OpenedContent, ToolExecuteContext, ToolInvocationContribution } from '@dbagent/core-agent';
import { createNodeWorkspaceMutationPrimitive } from '../src/node-workspace-mutation-primitive.js';
import {
  createResultMaterializeToolContribution,
  createResultSaveToolContribution,
} from '../src/result-file-tools.js';
import {
  RESULT_FILE_MAX_BYTES,
  ResultMaterializationStore,
  type ResultMaterializationOwner,
} from '../src/result-materialization-store.js';
import {
  createNoReplaceWorkspaceMutationAdapter,
  type WorkspaceMutationBinding,
  type WorkspaceMutationJournal,
  type WorkspaceMutationPrimitive,
  type WorkspaceMutationSnapshot,
} from '../src/workspace-mutation-adapter.js';

type Mkdir = typeof nodeMkdir;

const filesystem = vi.hoisted(() => ({
  mkdir: vi.fn<Mkdir>(),
  originalMkdir: undefined as unknown as Mkdir,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<{ mkdir: Mkdir }>();
  filesystem.originalMkdir = actual.mkdir;
  filesystem.mkdir.mockImplementation(actual.mkdir);
  return { ...actual, mkdir: filesystem.mkdir };
});

const directories: string[] = [];
const contentRef = `schemanaut-content:v1:artifact_${'a'.repeat(64)}:${'b'.repeat(64)}`;
const owner = Object.freeze({
  hostId: 'host-result-files',
  projectId: 'project-result-files',
  sessionId: 'session-result-files',
  runId: 'run-result-files',
});

afterEach(async () => {
  filesystem.mkdir.mockClear();
  filesystem.mkdir.mockImplementation(filesystem.originalMkdir);
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('result materialization', () => {
  it('uses one canonical root when explicit Runtime and project paths have different spellings', async () => {
    const root = await temporaryDirectory();
    const canonicalRoot = await realpath(root);
    const store = new ResultMaterializationStore({
      projectRoot: canonicalRoot,
      rootDirectory: join(root, 'explicit-runtime'),
    });

    expect(store.rootDirectory).toBe(join(canonicalRoot, 'explicit-runtime'));
    await expect(store.initialize(() => true)).resolves.toEqual({
      retainedRuns: 0,
      removedRuns: 0,
      pendingRuns: 0,
    });
  });

  it('materializes owner-scoped bytes at a project-relative Run path', async () => {
    const root = await temporaryDirectory();
    const bytes = new Uint8Array([0, 255, 10, 13, 42]);
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    const artifactStore = ownerScopedArtifactStore(bytes, owner);
    const contribution = createResultMaterializeToolContribution({
      artifactStore,
      materializationStore: store,
    });

    const result = await execute(contribution, { contentRef }, owner);

    expect(result).toMatchObject({
      status: 'ok',
      contentRef,
      contentType: 'application/x-ndjson',
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      lifecycle: 'run',
    });
    const temporaryPath = (result as { temporaryPath: string }).temporaryPath;
    expect(temporaryPath).toMatch(/^\.schemanaut\/runtime\/materialized\/run-[a-f0-9-]{36}\/content-[a-f0-9]{32}\.ndjson$/u);
    expect(isAbsolute(temporaryPath)).toBe(false);
    await expect(readFile(join(root, temporaryPath))).resolves.toEqual(Buffer.from(bytes));
    expect(artifactStore.requests).toEqual([owner]);
  });

  it('initializes two stores concurrently at the same fresh Runtime root', async () => {
    const root = await temporaryDirectory();
    const first = new ResultMaterializationStore({ projectRoot: root });
    const second = new ResultMaterializationStore({ projectRoot: root });
    const racedParent = join(await realpath(root), '.schemanaut');
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>(resolve => { release = resolve; });
    let realEexists = 0;
    filesystem.mkdir.mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] !== racedParent) return await filesystem.originalMkdir(...args);
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
      try {
        return await filesystem.originalMkdir(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') realEexists += 1;
        throw error;
      }
    });

    await expect(Promise.all([
      first.initialize(() => true),
      second.initialize(() => true),
    ])).resolves.toEqual([
      { retainedRuns: 0, removedRuns: 0, pendingRuns: 0 },
      { retainedRuns: 0, removedRuns: 0, pendingRuns: 0 },
    ]);
    expect(arrivals).toBe(2);
    expect(realEexists).toBe(1);
    await expect(readdir(first.rootDirectory)).resolves.toEqual([]);
  });

  it('rejects a file installed during the materialization root create race', async () => {
    const root = await temporaryDirectory();
    const racedParent = join(await realpath(root), '.schemanaut');
    let realEexists = 0;
    filesystem.mkdir.mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] !== racedParent) return await filesystem.originalMkdir(...args);
      await writeFile(racedParent, 'not a directory', 'utf8');
      try {
        return await filesystem.originalMkdir(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') realEexists += 1;
        throw error;
      }
    });

    const store = new ResultMaterializationStore({ projectRoot: root });
    await expect(store.initialize(() => true)).rejects.toThrow(
      'Runtime materialization directories cannot be symbolic links, junctions, or files.',
    );
    expect(realEexists).toBe(1);
  });

  it('preserves a non-EEXIST mkdir failure during materialization initialization', async () => {
    const root = await temporaryDirectory();
    const racedParent = join(await realpath(root), '.schemanaut');
    const denied = Object.assign(new Error('mkdir denied'), { code: 'EACCES' });
    filesystem.mkdir.mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] === racedParent) throw denied;
      return await filesystem.originalMkdir(...args);
    });

    const store = new ResultMaterializationStore({ projectRoot: root });
    await expect(store.initialize(() => true)).rejects.toBe(denied);
  });

  it('rejects a link installed during the materialization root create race', async context => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const racedParent = join(await realpath(root), '.schemanaut');
    let realEexists = 0;
    let linkError: unknown;
    filesystem.mkdir.mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] !== racedParent) return await filesystem.originalMkdir(...args);
      try {
        await symlink(external, racedParent, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        linkError = error;
        throw error;
      }
      try {
        return await filesystem.originalMkdir(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') realEexists += 1;
        throw error;
      }
    });

    const store = new ResultMaterializationStore({ projectRoot: root });
    const result: unknown = await store.initialize(() => true).then(
      () => undefined,
      error => error as unknown,
    );
    if (isLinkPermissionUnsupported(linkError)) {
      context.skip();
      return;
    }
    expect(result).toMatchObject({
      message: 'Runtime materialization directories cannot be symbolic links, junctions, or files.',
    });
    expect(realEexists).toBe(1);
  });

  it('reuses a verified materialization for the same Run and content reference', async () => {
    const root = await temporaryDirectory();
    const bytes = new Uint8Array([7, 0, 8, 255]);
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    const artifactStore = ownerScopedArtifactStore(bytes, owner);
    const contribution = createResultMaterializeToolContribution({ artifactStore, materializationStore: store });

    const first = await execute(contribution, { contentRef }, owner);
    const second = await execute(contribution, { contentRef }, owner);

    expect(second).toMatchObject({
      temporaryPath: (first as { temporaryPath: string }).temporaryPath,
      digest: digest(bytes),
      lifecycle: 'run',
    });
    await expect(readdir(store.rootDirectory)).resolves.toHaveLength(1);
  });

  it('removes a Run directory through idempotent cleanupRun', async () => {
    const root = await temporaryDirectory();
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    await store.materialize({
      opened: openedContent(new Uint8Array([1, 2, 3])),
      owner,
      signal: activeSignal(),
      deadline: activeDeadline(),
    });

    await expect(store.cleanupRun(owner)).resolves.toBe(true);
    await expect(store.cleanupRun(owner)).resolves.toBe(true);
    await expect(readdir(store.rootDirectory)).resolves.toEqual([]);
  });

  it('reaps terminal and orphaned Run directories while retaining a live owner at startup', async () => {
    const root = await temporaryDirectory();
    const liveOwner = withRun('run-live');
    const terminalOwner = withRun('run-terminal');
    const orphanOwner = withRun('run-orphan');
    const writer = new ResultMaterializationStore({ projectRoot: root });
    await writer.initialize(() => true);
    for (const runOwner of [liveOwner, terminalOwner, orphanOwner]) {
      await writer.materialize({
        opened: openedContent(new Uint8Array([runOwner.runId.length])),
        owner: runOwner,
        signal: activeSignal(),
        deadline: activeDeadline(),
      });
    }

    const restarted = new ResultMaterializationStore({ projectRoot: root });
    await expect(restarted.initialize(candidate => candidate.runId === liveOwner.runId)).resolves.toEqual({
      retainedRuns: 1,
      removedRuns: 2,
      pendingRuns: 0,
    });
    await expect(readdir(restarted.rootDirectory)).resolves.toHaveLength(1);
  });

  it('rejects a declared Runtime result above 64 MiB before creating a file', async () => {
    const root = await temporaryDirectory();
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    const contribution = createResultMaterializeToolContribution({
      artifactStore: ownerScopedArtifactStore(new Uint8Array(), owner, RESULT_FILE_MAX_BYTES + 1),
      materializationStore: store,
    });

    await expect(execute(contribution, { contentRef }, owner)).rejects.toThrow('64 MiB materialization limit');
    await expect(readdir(store.rootDirectory)).resolves.toEqual([]);
  });

  it('rejects a materialization root junction to the project root without removing project files', async context => {
    const root = await temporaryDirectory();
    const sentinel = join(root, 'project-sentinel.txt');
    const materializedRoot = join(root, '.schemanaut', 'runtime', 'materialized');
    await writeFile(sentinel, 'must remain', 'utf8');
    await mkdir(dirname(materializedRoot), { recursive: true });
    try {
      await symlink(root, materializedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (isLinkPermissionUnsupported(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    const store = new ResultMaterializationStore({ projectRoot: root });
    await expect(store.initialize(() => true)).rejects.toThrow();
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('must remain');
  });

  it('does not clean a replacement directory installed at the initialized root path', async () => {
    const root = await temporaryDirectory();
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    await store.materialize({
      opened: openedContent(new Uint8Array([1, 2, 3])),
      owner,
      signal: activeSignal(),
      deadline: activeDeadline(),
    });
    const [runDirectory] = await readdir(store.rootDirectory);
    const movedRoot = `${store.rootDirectory}-moved`;
    await rename(store.rootDirectory, movedRoot);
    await mkdir(join(store.rootDirectory, runDirectory!), { recursive: true });
    const sentinel = join(store.rootDirectory, runDirectory!, 'replacement-sentinel.txt');
    await writeFile(sentinel, 'must remain', 'utf8');

    await expect(store.cleanupRun(owner)).resolves.toBe(false);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('must remain');
  });

  it('rejects materialization after the initialized root is replaced by a junction', async context => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    await rename(store.rootDirectory, `${store.rootDirectory}-moved`);
    try {
      await symlink(external, store.rootDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (isLinkPermissionUnsupported(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(store.materialize({
      opened: openedContent(new Uint8Array([1, 2, 3])),
      owner,
      signal: activeSignal(),
      deadline: activeDeadline(),
    })).rejects.toThrow('changed after initialization');
    await expect(readdir(external)).resolves.toEqual(['exports']);
  });

  it('removes an actual streamed over-limit partial before it can be materialized', async () => {
    const root = await temporaryDirectory();
    const store = new ResultMaterializationStore({ projectRoot: root });
    await store.initialize(() => true);
    const chunk = new Uint8Array(1024 * 1024).fill(0x5a);

    await expect(store.materialize({
      opened: Object.freeze({
        stream: repeatedByteStream(chunk, 65),
        contentRef,
        contentType: 'application/x-ndjson',
        byteSize: RESULT_FILE_MAX_BYTES,
        checksum: '0'.repeat(64),
      }),
      owner,
      signal: activeSignal(),
      deadline: activeDeadline(),
    })).rejects.toThrow('64 MiB materialization limit');

    const [runDirectory] = await readdir(store.rootDirectory);
    expect(runDirectory).toMatch(/^run-[a-f0-9-]{36}$/u);
    await expect(readdir(join(store.rootDirectory, runDirectory!))).resolves.toEqual(['manifest.json']);
  }, 20_000);
});

describe('result_save', () => {
  it('creates a persistent workspace file with the original bytes', async () => {
    const root = await temporaryDirectory();
    const bytes = new Uint8Array([0, 255, 10, 13, 42]);
    const contribution = createResultSaveToolContribution({
      rootPath: root,
      artifactStore: ownerScopedArtifactStore(bytes, owner),
      mutationAdapter: createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive()),
    });

    const result = await execute(contribution, { contentRef, path: 'exports/result.ndjson' }, owner);

    expect(result).toMatchObject({
      status: 'ok',
      contentRef,
      path: 'exports/result.ndjson',
      canonicalPath: join(await realpath(root), 'exports', 'result.ndjson'),
      contentType: 'application/x-ndjson',
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      lifecycle: 'persistent',
    });
    await expect(readFile(join(root, 'exports', 'result.ndjson'))).resolves.toEqual(Buffer.from(bytes));
  });

  it('reports a typed conflict and never overwrites a target occupied after preparation', async () => {
    const root = await temporaryDirectory();
    const bytes = new Uint8Array([1, 2, 3]);
    const contribution = createResultSaveToolContribution({
      rootPath: root,
      artifactStore: ownerScopedArtifactStore(bytes, owner),
      mutationAdapter: createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive()),
    });
    const prepared = await contribution.runtime.prepare({ contentRef, path: 'result.ndjson' }, prepareContext(contribution.definition, owner));
    await writeFile(join(root, 'result.ndjson'), Buffer.from([9, 8, 7]));

    await expect(contribution.runtime.execute(prepared.input, executeContext(prepared, owner))).rejects.toThrow('target changed');
    await expect(readFile(join(root, 'result.ndjson'))).resolves.toEqual(Buffer.from([9, 8, 7]));
  });

  it('recovers a prepared streamed save from its Journal without reopening Runtime content', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 42]);
    const workspace = inMemoryWorkspacePrimitive();
    const adapter = createNoReplaceWorkspaceMutationAdapter(workspace.primitive);
    let openCalls = 0;
    const artifactStore: Pick<AgentArtifactStore, 'openContent'> = Object.freeze({
      openContent(request: ContentOpenRequest): Promise<OpenedContent> {
        openCalls += 1;
        expect(request.access).toEqual(owner);
        if (openCalls > 1) return Promise.reject(new Error('Artifact content must not be reopened during recovery.'));
        return Promise.resolve(openedContent(bytes));
      },
    });
    const contribution = createResultSaveToolContribution({
      rootPath: 'memory://workspace',
      artifactStore,
      mutationAdapter: adapter,
    });
    const prepared = await contribution.runtime.prepare(
      { contentRef, path: 'result.ndjson' },
      prepareContext(contribution.definition, owner),
    );
    const binding = (prepared.input as { binding: WorkspaceMutationBinding }).binding;
    workspace.stageTemporary(binding, bytes);

    const result = await contribution.runtime.recover!(prepared.input, executeContext(prepared, owner));

    expect(openCalls).toBe(1);
    expect(result).toMatchObject({
      status: 'ok',
      contentRef,
      path: 'result.ndjson',
      contentType: 'application/x-ndjson',
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      lifecycle: 'persistent',
    });
    expect([...workspace.entries.keys()]).toEqual([binding.entryName]);
    expect(workspace.entries.get(binding.entryName)?.bytes).toEqual(bytes);
    expect([...workspace.journals.keys()]).toEqual([]);
  });

  it('recovers a prepared streamed save when the Artifact Store is unavailable after restart', async () => {
    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    const workspace = inMemoryWorkspacePrimitive();
    const adapter = createNoReplaceWorkspaceMutationAdapter(workspace.primitive);
    const contribution = createResultSaveToolContribution({
      rootPath: 'memory://workspace',
      artifactStore: ownerScopedArtifactStore(bytes, owner),
      mutationAdapter: adapter,
    });
    const prepared = await contribution.runtime.prepare(
      { contentRef, path: 'result.ndjson' },
      prepareContext(contribution.definition, owner),
    );
    const binding = (prepared.input as { binding: WorkspaceMutationBinding }).binding;
    workspace.stageTemporary(binding, bytes);
    const restarted = createResultSaveToolContribution({
      rootPath: 'memory://workspace',
      mutationAdapter: adapter,
    });

    await expect(restarted.runtime.recover!(prepared.input, executeContext(prepared, owner))).resolves.toMatchObject({
      status: 'ok',
      path: 'result.ndjson',
      digest: digest(bytes),
      lifecycle: 'persistent',
    });
    expect(workspace.entries.get(binding.entryName)?.bytes).toEqual(bytes);
    expect([...workspace.journals.keys()]).toEqual([]);
  });
});

describe('result file Tool contracts', () => {
  it('does not give either Tool completion or final-state metadata', () => {
    const materialize = createResultMaterializeToolContribution({});
    const save = createResultSaveToolContribution({ rootPath: 'C:/result-file-contract-root' });

    for (const contribution of [materialize, save]) {
      expect(contribution.definition).not.toHaveProperty('completion');
      expect(contribution.definition).not.toHaveProperty('finalState');
      expect(contribution.definition).not.toHaveProperty('final');
      expect(contribution.definition).not.toHaveProperty('toolOrder');
    }
    expect(materialize.definition).toMatchObject({ access: 'read', recoveryClass: 'read' });
    expect(save.definition).toMatchObject({ access: 'write', recoveryClass: 'transactional' });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexus-result-files-'));
  directories.push(path);
  await mkdir(join(path, 'exports'), { recursive: true });
  return path;
}

function ownerScopedArtifactStore(
  bytes: Uint8Array,
  expectedOwner: ResultMaterializationOwner,
  declaredSize = bytes.byteLength,
): Pick<AgentArtifactStore, 'openContent'> & { requests: ResultMaterializationOwner[] } {
  const requests: ResultMaterializationOwner[] = [];
  return Object.freeze({
    requests,
    openContent(request: ContentOpenRequest): Promise<OpenedContent> {
      expect(request.contentRef).toBe(contentRef);
      expect(request.access).toEqual(expectedOwner);
      requests.push(request.access as ResultMaterializationOwner);
      return Promise.resolve(openedContent(bytes, declaredSize));
    },
  });
}

function openedContent(bytes: Uint8Array, byteSize = bytes.byteLength): OpenedContent {
  return Object.freeze({
    stream: byteStream(bytes),
    contentRef,
    contentType: 'application/x-ndjson',
    byteSize,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  });
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function repeatedByteStream(chunk: Uint8Array, count: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < count; index += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function withRun(runId: string): ResultMaterializationOwner {
  return Object.freeze({ ...owner, runId });
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function activeSignal(): AbortSignal { return new AbortController().signal; }
function activeDeadline(): string { return new Date(Date.now() + 10_000).toISOString(); }

function isLinkPermissionUnsupported(error: unknown): boolean {
  return process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(errorCode(error));
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
}

type MemoryEntry = Readonly<{ bytes: Uint8Array; identity: object }>;

function inMemoryWorkspacePrimitive(): {
  primitive: WorkspaceMutationPrimitive;
  entries: Map<string, MemoryEntry>;
  journals: Map<string, WorkspaceMutationJournal>;
  stageTemporary(binding: WorkspaceMutationBinding, bytes: Uint8Array): void;
} {
  const entries = new Map<string, MemoryEntry>();
  const journals = new Map<string, WorkspaceMutationJournal>();
  let identitySequence = 0;
  const entry = (bytes: Uint8Array): MemoryEntry => Object.freeze({
    bytes: new Uint8Array(bytes),
    identity: Object.freeze({ protocol: 'memory-entry.v1', id: String(++identitySequence) }),
  });
  const snapshot = (value: MemoryEntry): WorkspaceMutationSnapshot => Object.freeze({
    identity: value.identity as never,
    digest: digest(value.bytes),
    sizeBytes: value.bytes.byteLength,
  });
  const fence = Object.freeze({
    inspect(name: string): Promise<WorkspaceMutationSnapshot | undefined> {
      const value = entries.get(name);
      return Promise.resolve(value === undefined ? undefined : snapshot(value));
    },
    writeExclusive(name: string, bytes: Uint8Array): Promise<void> {
      if (entries.has(name)) return Promise.reject(new Error(`Memory entry ${name} already exists.`));
      entries.set(name, entry(bytes));
      return Promise.resolve();
    },
    async writeExclusiveStream(name: string, source: ReadableStream<Uint8Array>, options: { maxBytes: number }): Promise<Readonly<{ digest: string; sizeBytes: number }>> {
      if (entries.has(name)) throw new Error(`Memory entry ${name} already exists.`);
      const reader = source.getReader();
      const chunks: Uint8Array[] = [];
      let sizeBytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.byteLength > options.maxBytes - sizeBytes) throw new Error('Memory stream exceeds its byte limit.');
          chunks.push(next.value);
          sizeBytes += next.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
      entries.set(name, entry(bytes));
      return Object.freeze({ digest: digest(bytes), sizeBytes });
    },
    moveNoReplace(sourceName: string, targetName: string): Promise<void> {
      const source = entries.get(sourceName);
      if (source === undefined || entries.has(targetName)) return Promise.reject(new Error('Memory no-replace move failed.'));
      entries.set(targetName, source);
      entries.delete(sourceName);
      return Promise.resolve();
    },
    linkNoReplace(sourceName: string, targetName: string): Promise<void> {
      const source = entries.get(sourceName);
      if (source === undefined || entries.has(targetName)) return Promise.reject(new Error('Memory no-replace link failed.'));
      entries.set(targetName, source);
      return Promise.resolve();
    },
    unlink(name: string): Promise<void> { entries.delete(name); journals.delete(name); return Promise.resolve(); },
    readJournal(name: string): Promise<WorkspaceMutationJournal | undefined> { return Promise.resolve(journals.get(name)); },
    writeJournal(name: string, expectedPhase: 'missing' | WorkspaceMutationJournal['phase'], journal: WorkspaceMutationJournal): Promise<void> {
      const current = journals.get(name);
      if ((expectedPhase === 'missing' && current !== undefined) || (expectedPhase !== 'missing' && current?.phase !== expectedPhase)) {
        return Promise.reject(new Error('Memory Journal phase changed.'));
      }
      journals.set(name, journal);
      return Promise.resolve();
    },
    sync(): Promise<void> { return Promise.resolve(); },
  });
  const parentToken = Object.freeze({ protocol: 'memory-parent.v1' });
  const parentIdentity = Object.freeze({ protocol: 'memory-parent-identity.v1' });
  const primitive: WorkspaceMutationPrimitive = Object.freeze({
    revision: 'memory-result-save-recovery.v1',
    protocol: 'revalidated-parent-no-replace.v1',
    sameIdentity: (left, right) => left === right,
    bind(input) {
      return Promise.resolve(Object.freeze({
        canonicalPath: `memory://workspace/${input.requestedPath}`,
        displayPath: input.requestedPath,
        insideWorkspace: true,
        parentToken: parentToken as never,
        parentIdentity: parentIdentity as never,
        entryName: input.requestedPath,
      }));
    },
    async withParent(_parentToken, _parentIdentity, _signal, operation) { return await operation(fence); },
  });
  return {
    primitive,
    entries,
    journals,
    stageTemporary(binding, bytes) {
      entries.set(binding.temporaryName, entry(bytes));
      journals.set(binding.transactionName, Object.freeze({
        protocol: 'workspace-mutation-journal.v1',
        transactionName: binding.transactionName,
        action: 'create',
        phase: 'temporary_ready',
        desiredDigest: digest(bytes),
        streamed: true,
      }));
    },
  };
}

function prepareContext(descriptor: { name: string; toolRevision: string; handlerRevision: string; limits: unknown }, scope: ResultMaterializationOwner) {
  return {
    ...scope,
    turnId: 'turn-result-files',
    invocationId: 'invocation-result-files',
    idempotencyKey: 'idempotency-result-files',
    descriptor: { flatName: descriptor.name },
    toolRevision: descriptor.toolRevision,
    handlerRevision: descriptor.handlerRevision,
    generation: 1,
    limits: descriptor.limits,
    signal: activeSignal(),
  } as never;
}

function executeContext(intent: unknown, scope: ResultMaterializationOwner): ToolExecuteContext {
  return {
    ...scope,
    turnId: 'turn-result-files',
    invocationId: 'invocation-result-files',
    idempotencyKey: 'idempotency-result-files',
    fencingToken: 1,
    deadline: activeDeadline(),
    authorization: {},
    discoverableTools: [],
    discoverableCapabilities: [],
    reportProgress: () => undefined,
    signal: activeSignal(),
    intent,
  } as unknown as ToolExecuteContext;
}

async function execute(
  contribution: ToolInvocationContribution,
  input: Record<string, string>,
  scope: ResultMaterializationOwner,
) {
  const prepared = await contribution.runtime.prepare(input, prepareContext(contribution.definition, scope));
  return await contribution.runtime.execute(prepared.input, executeContext(prepared, scope));
}
