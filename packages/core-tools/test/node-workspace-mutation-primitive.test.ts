import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeWorkspaceMutationPrimitive,
  createNoReplaceWorkspaceMutationAdapter,
  type WorkspaceMutationPrimitive,
} from '../src/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, open: vi.fn(original.open) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Node workspace mutation primitive', () => {
  it('creates, conditionally updates, and deletes a regular workspace file', async () => {
    const rootPath = await temporaryWorkspace();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const signal = new AbortController().signal;

    const createBinding = await adapter.prepare({
      rootPath,
      requestedPath: 'analysis.py',
      action: 'create',
      desiredContent: 'print("first")\n',
      transactionKey: 'create-analysis',
      signal,
    });
    expect(await adapter.revalidate(createBinding, signal)).toBeUndefined();
    const created = await adapter.execute(createBinding, {
      desiredContent: 'print("first")\n',
      signal,
    });
    expect(created).toMatchObject({ status: 'ok', action: 'create', sizeBytes: 15 });
    expect(await readFile(join(rootPath, 'analysis.py'), 'utf8')).toBe('print("first")\n');

    const updateBinding = await adapter.prepare({
      rootPath,
      requestedPath: 'analysis.py',
      action: 'update',
      expectedDigest: requiredDigest(created.digest),
      transactionKey: 'update-analysis',
      signal,
    });
    expect(await adapter.revalidate(updateBinding, signal)).toBeUndefined();
    const updated = await adapter.execute(updateBinding, {
      edits: [{ oldText: 'first', newText: 'verified', replaceAll: false }],
      signal,
    });
    expect(updated).toMatchObject({ status: 'ok', action: 'update', replacements: 1 });
    expect(await readFile(join(rootPath, 'analysis.py'), 'utf8')).toBe('print("verified")\n');

    const deleteBinding = await adapter.prepare({
      rootPath,
      requestedPath: 'analysis.py',
      action: 'delete',
      expectedDigest: requiredDigest(updated.digest),
      transactionKey: 'delete-analysis',
      signal,
    });
    const deleted = await adapter.execute(deleteBinding, { signal });
    expect(deleted).toMatchObject({ status: 'ok', action: 'delete', deleted: true });
    await expect(readFile(join(rootPath, 'analysis.py'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(rootPath)).filter(name => name.startsWith('.schemanaut-'))).toEqual([]);
  });

  it('does not replace a file that appears after create preparation', async () => {
    const rootPath = await temporaryWorkspace();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const signal = new AbortController().signal;
    const binding = await adapter.prepare({
      rootPath,
      requestedPath: 'result.json',
      action: 'create',
      desiredContent: '{"agent":true}\n',
      transactionKey: 'concurrent-create',
      signal,
    });
    await writeFile(join(rootPath, 'result.json'), '{"external":true}\n', 'utf8');

    expect(await adapter.revalidate(binding, signal)).toBe('conflict');
    await expect(adapter.execute(binding, { desiredContent: '{"agent":true}\n', signal }))
      .rejects.toThrow(/concurrent file occupied/u);
    expect(await readFile(join(rootPath, 'result.json'), 'utf8')).toBe('{"external":true}\n');
  });

  it('cancels the source stream without deleting an occupied exclusive temporary path', async () => {
    const rootPath = await temporaryWorkspace();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const signal = new AbortController().signal;
    const binding = await adapter.prepare({
      rootPath,
      requestedPath: 'result.json',
      action: 'create',
      transactionKey: 'temporary-exclusive-open',
      signal,
    });
    await writeFile(join(rootPath, binding.temporaryName), 'occupied', 'utf8');
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      },
    });

    const execution = adapter.execute(binding, {
      desiredSource: source,
      maxSourceBytes: 1_024,
      signal,
    });
    await expect(execution).rejects.toMatchObject({ code: 'EEXIST' });

    expect(cancelReason).toMatchObject({ code: 'EEXIST' });
    await expect(execution).rejects.toBe(cancelReason);
    expect(await readFile(join(rootPath, binding.temporaryName), 'utf8')).toBe('occupied');
    expect(await readdir(rootPath)).toEqual([binding.temporaryName]);
  });

  it('preserves an occupied temporary path when an exclusive byte write fails', async () => {
    const rootPath = await temporaryWorkspace();
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    const signal = new AbortController().signal;
    const binding = await adapter.prepare({
      rootPath,
      requestedPath: 'result.json',
      action: 'create',
      transactionKey: 'temporary-byte-exclusive-open',
      signal,
    });
    await writeFile(join(rootPath, binding.temporaryName), 'occupied', 'utf8');

    await expect(adapter.execute(binding, { desiredContent: 'new content', signal }))
      .rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(join(rootPath, binding.temporaryName), 'utf8')).toBe('occupied');
    expect(await readdir(rootPath)).toEqual([binding.temporaryName]);
  });

  it('removes its own partial byte write and preserves write-before-close error ordering', async () => {
    const rootPath = await temporaryWorkspace();
    const primitive = createNodeWorkspaceMutationPrimitive();
    const signal = new AbortController().signal;
    const binding = await primitive.bind({ rootPath, requestedPath: 'temporary', signal });
    const writeFailure = new Error('injected partial write failure');
    const closeFailure = new Error('injected close failure');
    const actualFs = await vi.importActual<typeof FileSystem>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
        await write(...writeArgs);
        throw writeFailure;
      });
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        throw closeFailure;
      });
      return handle;
    });

    const execution = primitive.withParent(binding.parentToken, binding.parentIdentity, signal,
      fence => fence.writeExclusive(binding.entryName, new TextEncoder().encode('partial'), signal));
    await expect(execution).rejects.toBeInstanceOf(AggregateError);
    await expect(execution).rejects.toMatchObject({ errors: [writeFailure, closeFailure] });
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('removes its own streamed file if closing the completed write fails', async () => {
    const rootPath = await temporaryWorkspace();
    const primitive = createNodeWorkspaceMutationPrimitive();
    const signal = new AbortController().signal;
    const binding = await primitive.bind({ rootPath, requestedPath: 'temporary', signal });
    const closeFailure = new Error('injected stream close failure');
    const actualFs = await vi.importActual<typeof FileSystem>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        throw closeFailure;
      });
      return handle;
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('complete'));
        controller.close();
      },
    });

    await expect(primitive.withParent(binding.parentToken, binding.parentIdentity, signal,
      fence => fence.writeExclusiveStream(binding.entryName, source, { maxBytes: 1_024, signal })))
      .rejects.toBe(closeFailure);
    expect(source.locked).toBe(false);
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('preserves the primary exclusive-open error when Journal cleanup also fails', async () => {
    const rootPath = await temporaryWorkspace();
    const nodePrimitive = createNodeWorkspaceMutationPrimitive();
    const journalFailure = new Error('injected Journal cleanup failure');
    const primitive: WorkspaceMutationPrimitive = {
      ...nodePrimitive,
      withParent(parentToken, parentIdentity, signal, operation) {
        return nodePrimitive.withParent(parentToken, parentIdentity, signal, fence => operation({
          ...fence,
          unlink(name) {
            return name.startsWith('.schemanaut-txn-') ? Promise.reject(journalFailure) : fence.unlink(name);
          },
        }));
      },
    };
    const adapter = createNoReplaceWorkspaceMutationAdapter(primitive);
    const signal = new AbortController().signal;
    const binding = await adapter.prepare({
      rootPath, requestedPath: 'result.json', action: 'create', transactionKey: 'journal-cleanup-failure', signal,
    });
    await writeFile(join(rootPath, binding.temporaryName), 'occupied', 'utf8');
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) { cancelReason = reason; },
    });
    const execution = adapter.execute(binding, { desiredSource: source, signal });

    const failure: unknown = await execution.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('Expected the write and Journal cleanup errors.');
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(cancelReason);
    expect(failure.errors[0]).toMatchObject({ code: 'EEXIST' });
    const cleanupFailure: unknown = failure.errors[1];
    expect(cleanupFailure).toBeInstanceOf(Error);
    if (!(cleanupFailure instanceof Error)) throw new Error('Expected the Journal cleanup error.');
    expect(cleanupFailure.message).toContain(journalFailure.message);
    expect(await readFile(join(rootPath, binding.temporaryName), 'utf8')).toBe('occupied');
    expect(await readdir(rootPath)).toContain(binding.transactionName);
  });

  it.each([
    ['recover', 'create', false],
    ['execute', 'create', false],
    ['recover', 'create', true],
    ['execute', 'create', true],
    ['recover', 'update', false],
    ['execute', 'update', false],
  ] as const)('preserves unowned prepared-state files via %s for %s (matching target: %s)', async (entry, action, matchingTarget) => {
    const rootPath = await temporaryWorkspace();
    const primitive = createNodeWorkspaceMutationPrimitive();
    const adapter = createNoReplaceWorkspaceMutationAdapter(primitive);
    const signal = new AbortController().signal;
    const originalContent = 'original';
    const desiredContent = 'replacement';
    const expectedDigest = `sha256:${createHash('sha256').update(originalContent).digest('hex')}`;
    if (action === 'update') await writeFile(join(rootPath, 'result.json'), originalContent, 'utf8');
    const binding = await adapter.prepare({
      rootPath,
      requestedPath: 'result.json',
      action,
      desiredContent,
      ...(action === 'update' ? { expectedDigest } : {}),
      transactionKey: `prepared-${entry}-${action}-${String(matchingTarget)}`,
      signal,
    });
    await primitive.withParent(binding.parentToken, binding.parentIdentity, signal, async fence => {
      await fence.writeJournal(binding.transactionName, 'missing', {
        protocol: 'workspace-mutation-journal.v1',
        transactionName: binding.transactionName,
        action,
        phase: 'prepared',
        ...(binding.expectedDigest === undefined ? {} : { expectedDigest: binding.expectedDigest }),
        ...(binding.desiredDigest === undefined ? {} : { desiredDigest: binding.desiredDigest }),
      });
      await fence.sync();
    });
    // A different writer occupies these names after the prepared phase is durable.
    await writeFile(join(rootPath, binding.temporaryName), desiredContent, 'utf8');
    if (matchingTarget) await writeFile(join(rootPath, binding.entryName), desiredContent, 'utf8');

    const recovery = entry === 'recover'
      ? adapter.recover(binding, signal)
      : adapter.execute(binding, { desiredContent, signal });
    await expect(recovery).rejects.toThrow(`The interrupted ${action} did not publish any content.`);

    expect(await readFile(join(rootPath, binding.temporaryName), 'utf8')).toBe(desiredContent);
    if (action === 'update' || matchingTarget) {
      expect(await readFile(join(rootPath, binding.entryName), 'utf8')).toBe(matchingTarget ? desiredContent : originalContent);
    } else {
      await expect(readFile(join(rootPath, binding.entryName))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(join(rootPath, binding.transactionName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(adapter.recover(binding, signal)).rejects.toThrow('No recoverable workspace transaction was found.');
  });

  it.each(['recover', 'execute'] as const)('recovers a prepared delete via %s without touching an unowned temporary path', async entry => {
    const rootPath = await temporaryWorkspace();
    const primitive = createNodeWorkspaceMutationPrimitive();
    const adapter = createNoReplaceWorkspaceMutationAdapter(primitive);
    const signal = new AbortController().signal;
    await writeFile(join(rootPath, 'result.json'), 'original', 'utf8');
    const expectedDigest = `sha256:${createHash('sha256').update('original').digest('hex')}`;
    const binding = await adapter.prepare({
      rootPath, requestedPath: 'result.json', action: 'delete', expectedDigest, transactionKey: `prepared-delete-${entry}`, signal,
    });
    await primitive.withParent(binding.parentToken, binding.parentIdentity, signal, async fence => {
      await fence.writeJournal(binding.transactionName, 'missing', {
        protocol: 'workspace-mutation-journal.v1', transactionName: binding.transactionName,
        action: 'delete', phase: 'prepared', expectedDigest,
      });
      await fence.sync();
      await fence.moveNoReplace(binding.entryName, binding.backupName);
    });
    await writeFile(join(rootPath, binding.temporaryName), 'external', 'utf8');

    const recovery = entry === 'recover' ? adapter.recover(binding, signal) : adapter.execute(binding, { signal });
    await expect(recovery).resolves.toMatchObject({ status: 'ok', action: 'delete', deleted: true });

    expect(await readFile(join(rootPath, binding.temporaryName), 'utf8')).toBe('external');
    expect(await readdir(rootPath)).toEqual([binding.temporaryName]);
  });

  it('rejects directories as mutation targets', async () => {
    const rootPath = await temporaryWorkspace();
    await mkdir(join(rootPath, 'nested'));
    const adapter = createNoReplaceWorkspaceMutationAdapter(createNodeWorkspaceMutationPrimitive());
    await expect(adapter.prepare({
      rootPath,
      requestedPath: 'nested',
      action: 'delete',
      expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      transactionKey: 'directory-target',
      signal: new AbortController().signal,
    })).rejects.toThrow(/regular files/u);
  });
});

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-node-mutation-'));
  temporaryDirectories.push(path);
  return path;
}

function requiredDigest(value: string | undefined): string {
  if (value === undefined) throw new Error('The mutation result did not include a digest.');
  return value;
}
