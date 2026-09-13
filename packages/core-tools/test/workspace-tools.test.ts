import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { afterEach, describe, expect, it } from 'vitest';
import { createNoReplaceWorkspaceMutationAdapter } from '../src/workspace-mutation-adapter.js';
import { createNodeWorkspaceMutationPrimitive } from '../src/node-workspace-mutation-primitive.js';
import { createRipgrepWorkspaceSearchBackend } from '../src/workspace-search-rg-adapter.js';
import { createWorkspaceToolGeneration } from '../src/workspace-tools.js';

const directories: string[] = [];
const PATCH_FILE_BYTES = 8 * 1024 * 1024;
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('workspace prepared tools', () => {
  it('has exactly the four current tool names with no write/edit aliases', async () => {
    const root = await temporaryDirectory();
    const generation = createWorkspaceToolGeneration({ rootPath: root });
    expect(generation.contributions.map(({ definition }) => definition.name)).toEqual([
      'workspace_list', 'workspace_read', 'workspace_search', 'workspace_apply_patch',
    ]);
    expect(generation.contributions.find(({ definition }) => definition.name === 'workspace_apply_patch')?.definition).toMatchObject({ access: 'destructive', recoveryClass: 'transactional' });
  });

  it('uses the bundled ripgrep runtime for ordinary bounded list, read, and search payloads', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'revenue.sql'), 'SELECT sum(net_amount) FROM orders;\n', 'utf8');
    expect((await stat(rgPath)).isFile()).toBe(true);
    const generation = createWorkspaceToolGeneration({ rootPath: root });
    await expect(execute(generation, 'workspace_list', { path: '.' })).resolves.toMatchObject({ status: 'ok', entries: [{ path: 'revenue.sql', type: 'file' }] });
    await expect(execute(generation, 'workspace_read', { path: 'revenue.sql', maxBytes: 16 })).resolves.toMatchObject({ status: 'ok', path: 'revenue.sql' });
    await expect(execute(generation, 'workspace_search', { query: 'net_amount' })).resolves.toMatchObject({ status: 'ok', matches: [{ path: 'revenue.sql', line: 1 }] });
    await expect(execute(generation, 'workspace_apply_patch', { action: 'update', path: 'revenue.sql', expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', edits: [{ oldText: 'orders', newText: 'paid_orders' }] })).resolves.toMatchObject({ status: 'unavailable', reason: 'conditional_mutation_backend_unavailable' });
  }, 20_000);

  it('keeps the explicit unavailable contract when an injected ripgrep executable is absent', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'revenue.sql'), 'SELECT sum(net_amount) FROM orders;\n', 'utf8');
    const backend = createRipgrepWorkspaceSearchBackend({ executable: join(root, 'missing-rg') });
    const targetIdentity = await portableIdentity(root);

    await expect(backend.search({
      targetPath: root,
      targetIdentity,
      relativePath: '.',
      ownerKey: 'workspace-search-test',
      query: 'net_amount',
      mode: 'literal',
      caseSensitive: false,
      binary: 'exclude',
      globs: [],
      maxFiles: 10,
      maxScanBytes: 1024 * 1024,
      maxResults: 10,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 10_000,
      signal: activeSignal(),
    })).resolves.toMatchObject({ status: 'unavailable', reason: 'ripgrep_not_found' });
    await expect(backend.drain()).resolves.toBeUndefined();
  });

  it('rejects a stale read digest before any payload is emitted', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'file.txt'), 'first', 'utf8');
    const generation = createWorkspaceToolGeneration({ rootPath: root });
    const contribution = generation.contributions.find(({ definition }) => definition.name === 'workspace_read')!;
    const prepared = await contribution.runtime.prepare({ path: 'file.txt' }, prepareContext(contribution.definition));
    await writeFile(join(root, 'file.txt'), 'second', 'utf8');
    await expect(generation.revalidateTarget(prepared, executeContext(prepared))).resolves.toBe('target_changed');
  });

  it('ignores prepared targets owned by another Tool domain', async () => {
    const root = await temporaryDirectory();
    const generation = createWorkspaceToolGeneration({ rootPath: root });
    const foreign = {
      input: {},
      permission: { toolName: 'data_profile' },
      targetIdentity: { kind: 'data-file', path: join(root, 'data.json') },
    } as never;
    await expect(generation.revalidateTarget(foreign, executeContext(foreign))).resolves.toBeUndefined();
  });
});

describe('streamed workspace mutation publication', () => {
  it('creates byte-faithful content from a streamed source', async () => {
    const root = await temporaryDirectory();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const binding = await adapter.prepare({
      rootPath: root, requestedPath: 'result.ndjson', action: 'create', transactionKey: 'streamed-create', signal: activeSignal(),
    });
    const bytes = new Uint8Array([0, 255, 10, 13, 42]);

    const result = await adapter.execute(binding, {
      desiredSource: byteStream(bytes.subarray(0, 2), bytes.subarray(2)), maxSourceBytes: bytes.byteLength,
      signal: activeSignal(), deadline: activeDeadline(),
    });

    await expect(readFile(join(root, 'result.ndjson'))).resolves.toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({
      status: 'ok', sizeBytes: bytes.byteLength,
      digest: 'sha256:5a44f143bd89e639ab6bd15d97c5989b3d5f58f4d7c0055f884bd781e0032468',
    });
  });

  it('does not replace a target created after streamed preparation', async () => {
    const root = await temporaryDirectory();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const binding = await adapter.prepare({
      rootPath: root, requestedPath: 'result.ndjson', action: 'create', transactionKey: 'streamed-conflict', signal: activeSignal(),
    });
    await writeFile(join(root, 'result.ndjson'), 'existing', 'utf8');

    await expect(adapter.execute(binding, {
      desiredSource: byteStream(new Uint8Array([1, 2, 3])), maxSourceBytes: 3, signal: activeSignal(), deadline: activeDeadline(),
    })).rejects.toThrow('concurrent file occupied');
    await expect(readFile(join(root, 'result.ndjson'), 'utf8')).resolves.toBe('existing');
  });

  it('cleans up streamed temporary state when its byte limit is exceeded', async () => {
    const root = await temporaryDirectory();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const binding = await adapter.prepare({
      rootPath: root, requestedPath: 'too-large.ndjson', action: 'create', transactionKey: 'streamed-limit', signal: activeSignal(),
    });

    await expect(adapter.execute(binding, {
      desiredSource: byteStream(new Uint8Array([1, 2]), new Uint8Array([3, 4])), maxSourceBytes: 3,
      signal: activeSignal(), deadline: activeDeadline(),
    })).rejects.toThrow('exceeds its byte limit');
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('cleans up the transaction when the supplied stream is already locked', async () => {
    const root = await temporaryDirectory();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const binding = await adapter.prepare({
      rootPath: root, requestedPath: 'locked.ndjson', action: 'create', transactionKey: 'streamed-locked', signal: activeSignal(),
    });
    const source = new ReadableStream<Uint8Array>();
    const lock = source.getReader();
    try {
      await expect(adapter.execute(binding, {
        desiredSource: source, maxSourceBytes: 1, signal: activeSignal(), deadline: activeDeadline(),
      })).rejects.toThrow(/locked/u);
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      lock.releaseLock();
    }
  });

  it('keeps legacy string create recovery at the 8 MiB ceiling', async () => {
    const root = await temporaryDirectory();
    const { adapter, binding } = await stagedCreateRecovery(root, false);

    await expect(adapter.recover(binding, activeSignal())).rejects.toThrow('readable file limit');
    await expect(readFile(join(root, binding.entryName))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a streamed create above the legacy 8 MiB ceiling', async () => {
    const root = await temporaryDirectory();
    const { adapter, binding, bytes } = await stagedCreateRecovery(root, true);

    await expect(adapter.recover(binding, activeSignal())).resolves.toMatchObject({ status: 'ok', sizeBytes: bytes.byteLength });
    await expect(readFile(join(root, binding.entryName))).resolves.toEqual(bytes);
  });
});

async function temporaryDirectory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'nexus-workspace-')); directories.push(path); return path; }

async function portableIdentity(path: string) {
  const canonicalPath = await realpath(path);
  const information = await stat(canonicalPath, { bigint: true });
  return {
    kind: 'filesystem-entry' as const,
    canonicalPath,
    type: information.isFile() ? 'file' as const : information.isDirectory() ? 'directory' as const : 'other' as const,
    device: information.dev.toString(),
    inode: information.ino.toString(),
    sizeBytes: Number(information.size),
    mtimeMs: Number(information.mtimeMs),
    mtimeNs: information.mtimeNs.toString(),
    ctimeNs: information.ctimeNs.toString(),
  };
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function activeSignal(): AbortSignal { return new AbortController().signal; }
function activeDeadline(): string { return new Date(Date.now() + 10_000).toISOString(); }

async function stagedCreateRecovery(root: string, streamed: boolean) {
  const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
  const binding = await adapter.prepare({
    rootPath: root, requestedPath: streamed ? 'streamed-recovery.ndjson' : 'legacy-recovery.txt', action: 'create',
    transactionKey: streamed ? 'streamed-recovery' : 'legacy-recovery', signal: activeSignal(),
  });
  const bytes = Buffer.alloc(PATCH_FILE_BYTES + 1, streamed ? 0x53 : 0x4c);
  const desiredDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  await writeFile(join(root, binding.temporaryName), bytes);
  await writeFile(join(root, binding.transactionName), `${JSON.stringify({
    protocol: 'workspace-mutation-journal.v1', transactionName: binding.transactionName, action: 'create', phase: 'temporary_ready', desiredDigest,
    ...(streamed ? { streamed: true } : {}),
  })}\n`, 'utf8');
  return { adapter, binding, bytes };
}

function prepareContext(descriptor: { name: string; toolRevision: string; handlerRevision: string; limits: unknown }) {
  return {
    hostId: 'local', projectId: 'project-tools', sessionId: 'session-tools', runId: 'run-tools', turnId: 'turn-tools', invocationId: 'invocation-tools',
    descriptor: { flatName: descriptor.name }, toolRevision: descriptor.toolRevision, handlerRevision: descriptor.handlerRevision, generation: 1,
    limits: descriptor.limits, signal: new AbortController().signal,
  } as never;
}

function executeContext(intent: unknown) {
  return { hostId: 'local', projectId: 'project-tools', sessionId: 'session-tools', runId: 'run-tools', turnId: 'turn-tools', invocationId: 'invocation-tools', intent, signal: new AbortController().signal, deadline: new Date(Date.now() + 10_000).toISOString() } as never;
}

async function execute(generation: ReturnType<typeof createWorkspaceToolGeneration>, name: string, input: Record<string, unknown>) {
  const contribution = generation.contributions.find(({ definition }) => definition.name === name)!;
  const context = prepareContext(contribution.definition);
  const intent = await contribution.runtime.prepare(input as never, context);
  return await contribution.runtime.execute(intent.input, executeContext(intent));
}
