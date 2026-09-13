import { createHash } from 'node:crypto';
import { expectedToolError } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';

const MAX_PATCH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_FILE_BYTES = 64 * 1024 * 1024;

export type WorkspaceMutationAction = 'create' | 'update' | 'delete';
export type WorkspacePatchEdit = Readonly<{ oldText: string; newText: string; replaceAll: boolean }>;

export type WorkspaceMutationBinding = Readonly<{
  protocol: 'workspace-mutation-binding.v1';
  adapterRevision: string;
  action: WorkspaceMutationAction;
  canonicalPath: string;
  displayPath: string;
  insideWorkspace: boolean;
  parentToken: PortableValue;
  parentIdentity: PortableValue;
  entryName: string;
  targetIdentity?: PortableValue;
  expectedDigest?: string;
  desiredDigest?: string;
  transactionName: string;
  temporaryName: string;
  backupName: string;
}>;

export type WorkspaceMutationResult = Readonly<{
  status: 'ok' | 'unavailable';
  summary: string;
  reason?: string;
  action: WorkspaceMutationAction;
  canonicalPath: string;
  displayPath: string;
  previousDigest?: string;
  digest?: string;
  sizeBytes?: number;
  replacements?: number;
  deleted?: boolean;
  identity?: PortableValue;
}>;

export type WorkspaceMutationAdapter = Readonly<{
  revision: string;
  protocol: 'workspace-mutation-cas.v1';
  prepare(input: Readonly<{
    rootPath: string;
    requestedPath: string;
    action: WorkspaceMutationAction;
    expectedDigest?: string;
    desiredContent?: string;
    transactionKey: string;
    signal: AbortSignal;
  }>): Promise<WorkspaceMutationBinding>;
  revalidate(binding: WorkspaceMutationBinding, signal: AbortSignal): Promise<'target_changed' | 'conflict' | void>;
  execute(binding: WorkspaceMutationBinding, input: Readonly<{
    desiredContent?: string;
    desiredSource?: ReadableStream<Uint8Array>;
    maxSourceBytes?: number;
    edits?: readonly WorkspacePatchEdit[];
    signal: AbortSignal;
    deadline?: string;
  }>): Promise<WorkspaceMutationResult>;
  recover(binding: WorkspaceMutationBinding, signal: AbortSignal): Promise<WorkspaceMutationResult>;
}>;

export type WorkspaceMutationSnapshot = Readonly<{
  identity: PortableValue;
  digest: string;
  sizeBytes: number;
  content?: Uint8Array;
}>;

export type WorkspaceMutationJournal = Readonly<{
  protocol: 'workspace-mutation-journal.v1';
  transactionName: string;
  action: WorkspaceMutationAction;
  phase: 'prepared' | 'temporary_ready' | 'target_backed_up' | 'published' | 'committed' | 'rolled_back';
  expectedDigest?: string;
  desiredDigest?: string;
  streamed?: true;
}>;

/**
 * Every callback is bound to one canonical parent identity. Providers must
 * revalidate that identity around the callback, reject symlinks/reparse points
 * for final entries, and implement no-replace move/link primitives.
 */
export type WorkspaceParentMutationFence = Readonly<{
  inspect(name: string, options?: { includeContent?: boolean; maxBytes?: number }): Promise<WorkspaceMutationSnapshot | undefined>;
  /** Failed writes clean only the temporary file successfully created by this call. */
  writeExclusive(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Owns source cancellation and cleanup after successful exclusive creation. */
  writeExclusiveStream(name: string, source: ReadableStream<Uint8Array>, options: Readonly<{
    maxBytes: number;
    signal: AbortSignal;
    deadline?: string;
  }>): Promise<Readonly<{ digest: string; sizeBytes: number }>>;
  moveNoReplace(sourceName: string, targetName: string): Promise<void>;
  linkNoReplace(sourceName: string, targetName: string): Promise<void>;
  unlink(name: string): Promise<void>;
  readJournal(name: string): Promise<WorkspaceMutationJournal | undefined>;
  /** Atomically create from `missing`, or CAS the exact prior phase before a durable phase advance. */
  writeJournal(name: string, expectedPhase: 'missing' | WorkspaceMutationJournal['phase'], journal: WorkspaceMutationJournal): Promise<void>;
  sync(): Promise<void>;
}>;

export type WorkspaceMutationPrimitive = Readonly<{
  revision: string;
  protocol: 'revalidated-parent-no-replace.v1';
  /** Compare opaque entry identities without treating a pathname field as identity. */
  sameIdentity(left: PortableValue, right: PortableValue): boolean;
  bind(input: Readonly<{ rootPath: string; requestedPath: string; signal: AbortSignal }>): Promise<Readonly<{
    canonicalPath: string;
    displayPath: string;
    insideWorkspace: boolean;
    parentToken: PortableValue;
    parentIdentity: PortableValue;
    entryName: string;
  }>>;
  withParent<T>(parentToken: PortableValue, parentIdentity: PortableValue, signal: AbortSignal, operation: (fence: WorkspaceParentMutationFence) => Promise<T>): Promise<T>;
}>;

/**
 * Portable transaction state machine over a Host-native parent fence. It never
 * replaces an occupied pathname: current→backup is no-replace and publishing is
 * a no-replace hard link. Every crash-relevant name is derived in prepare and a
 * deterministic journal is fsynced before/after each phase.
 */
const issuedMutationAdapters = new WeakSet<object>();

export function assertNoReplaceWorkspaceMutationAdapter(value: WorkspaceMutationAdapter): void {
  if (!issuedMutationAdapters.has(value)) throw new TypeError('Workspace mutation adapter must be issued by the trusted no-replace adapter factory.');
}

export function createNoReplaceWorkspaceMutationAdapter(
  primitive: WorkspaceMutationPrimitive,
): WorkspaceMutationAdapter {
  if (primitive.protocol !== 'revalidated-parent-no-replace.v1') throw new TypeError('A revalidated-parent no-replace mutation primitive is required.');
  const revision = `workspace-mutation-cas.v1:${primitive.revision}`;
  Object.freeze(primitive);
  const adapter: WorkspaceMutationAdapter = Object.freeze({
    revision,
    protocol: 'workspace-mutation-cas.v1' as const,
    async prepare(input) {
      throwIfAborted(input.signal);
      const bound = await primitive.bind(input);
      const suffix = createHash('sha256').update(`${revision}\0${input.transactionKey}\0${bound.canonicalPath}`).digest('hex').slice(0, 32);
      const desiredDigest = input.desiredContent === undefined ? undefined : digest(Buffer.from(input.desiredContent, 'utf8'));
      const binding: WorkspaceMutationBinding = Object.freeze({
        protocol: 'workspace-mutation-binding.v1', adapterRevision: revision, action: input.action,
        canonicalPath: bound.canonicalPath, displayPath: bound.displayPath, insideWorkspace: bound.insideWorkspace,
        parentToken: bound.parentToken, parentIdentity: bound.parentIdentity, entryName: bound.entryName,
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
        ...(desiredDigest === undefined ? {} : { desiredDigest }),
        transactionName: `.schemanaut-txn-${suffix}.json`, temporaryName: `.schemanaut-tmp-${suffix}`,
        backupName: `.schemanaut-backup-${suffix}`,
      });
      return await primitive.withParent(bound.parentToken, bound.parentIdentity, input.signal, async (fence) => {
        const current = await fence.inspect(bound.entryName, { includeContent: input.action === 'update', maxBytes: 8 * 1024 * 1024 });
        if (input.action === 'create') {
          if (current !== undefined) throw expectedToolError('conflict', 'The file already exists.');
          return binding;
        }
        if (current === undefined) throw expectedToolError('not_found', 'The requested file does not exist.');
        if (current.digest !== input.expectedDigest) throw expectedToolError('conflict', 'The expected digest does not match the current file.');
        return Object.freeze({ ...binding, targetIdentity: current.identity });
      });
    },
    async revalidate(binding, signal) {
      assertBinding(binding, revision);
      return await primitive.withParent(binding.parentToken, binding.parentIdentity, signal, async (fence) => {
        const current = await fence.inspect(binding.entryName);
        if (binding.action === 'create') return current === undefined ? undefined : 'conflict';
        if (current === undefined || binding.targetIdentity === undefined || !primitive.sameIdentity(current.identity, binding.targetIdentity)) return 'target_changed';
        return current.digest === binding.expectedDigest ? undefined : 'conflict';
      });
    },
    async execute(binding, input) {
      assertBinding(binding, revision);
      return await primitive.withParent(binding.parentToken, binding.parentIdentity, input.signal, async (fence) => {
        const journal = await fence.readJournal(binding.transactionName);
        if (journal !== undefined) return recoverTransaction(primitive, fence, binding, journal, input.signal);
        const desired = await desiredContent(primitive, fence, binding, input);
        const streamed = desired?.kind === 'source';
        let desiredDigest = desired?.kind === 'bytes' ? digest(desired.bytes) : undefined;
        let desiredSizeBytes: number | undefined;
        await writePhase(fence, binding, 'missing', 'prepared', desiredDigest, streamed);
        if (desired !== undefined) {
          try {
            if (desired.kind === 'bytes') {
              await fence.writeExclusive(binding.temporaryName, desired.bytes, input.signal);
              desiredSizeBytes = desired.bytes.byteLength;
            } else {
              const written = await fence.writeExclusiveStream(binding.temporaryName, desired.source, {
                maxBytes: desired.maxBytes, signal: input.signal, ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
              });
              desiredDigest = written.digest;
              desiredSizeBytes = written.sizeBytes;
            }
          } catch (error) {
            try {
              await cleanupUnpublishedJournal(fence, binding);
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Workspace mutation write and Journal cleanup did not both complete.');
            }
            throw error;
          }
          await writePhase(fence, binding, 'prepared', 'temporary_ready', desiredDigest, streamed);
        }
        if (binding.action !== 'create') {
          await fence.moveNoReplace(binding.entryName, binding.backupName);
          await writePhase(fence, binding, binding.action === 'delete' ? 'prepared' : 'temporary_ready', 'target_backed_up', desiredDigest, streamed);
          const moved = await fence.inspect(binding.backupName);
          if (moved === undefined || moved.digest !== binding.expectedDigest || binding.targetIdentity === undefined || !primitive.sameIdentity(moved.identity, binding.targetIdentity)) {
            await rollbackMovedEntry(primitive, fence, binding, desiredDigest);
            throw expectedToolError('conflict', 'The conditional mutation target changed at commit.');
          }
        }
        if (binding.action !== 'delete') {
          try { await fence.linkNoReplace(binding.temporaryName, binding.entryName); }
          catch (error) {
            if (binding.action === 'create') {
              await cleanupRollback(fence, binding, 'temporary_ready', desiredDigest, desired?.maxBytes, streamed);
              throw expectedToolError('conflict', 'A concurrent file occupied the create target.');
            }
            throw unknown(binding, `A concurrent entry prevented conditional publication: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
          await writePhase(fence, binding, binding.action === 'create' ? 'temporary_ready' : 'target_backed_up', 'published', desiredDigest, streamed);
          const published = await inspectWithMaxBytes(fence, binding.entryName, desired?.maxBytes);
          if (published === undefined || published.digest !== desiredDigest || published.sizeBytes !== desiredSizeBytes) {
            throw unknown(binding, 'Published content could not be verified.');
          }
        }
        return await finishCommit(
          fence,
          binding,
          binding.action === 'delete' ? 'target_backed_up' : 'published',
          desired?.replacements,
          desiredDigest,
          desired?.maxBytes,
          streamed,
        );
      });
    },
    async recover(binding, signal) {
      assertBinding(binding, revision);
      return await primitive.withParent(binding.parentToken, binding.parentIdentity, signal, async (fence) => {
        const journal = await fence.readJournal(binding.transactionName);
        if (journal === undefined) throw expectedToolError('conflict', 'No recoverable workspace transaction was found.');
        return recoverTransaction(primitive, fence, binding, journal, signal);
      });
    },
  });
  issuedMutationAdapters.add(adapter);
  return adapter;
}

type DesiredMutation = Readonly<{
  kind: 'bytes';
  bytes: Uint8Array;
  replacements: number;
  maxBytes: typeof MAX_PATCH_FILE_BYTES;
}> | Readonly<{
  kind: 'source';
  source: ReadableStream<Uint8Array>;
  replacements: 0;
  maxBytes: number;
}>;

async function desiredContent(
  primitive: WorkspaceMutationPrimitive,
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  input: Readonly<{
    desiredContent?: string;
    desiredSource?: ReadableStream<Uint8Array>;
    maxSourceBytes?: number;
    edits?: readonly WorkspacePatchEdit[];
    signal: AbortSignal;
  }>,
): Promise<DesiredMutation | undefined> {
  if (input.desiredContent !== undefined && input.desiredSource !== undefined) {
    throw expectedToolError('invalid_argument', 'Create content and source are mutually exclusive.');
  }
  if (binding.action === 'delete') return undefined;
  if (binding.action === 'create') {
    if (input.desiredSource !== undefined) {
      const maxBytes = input.maxSourceBytes === undefined ? MAX_STREAM_FILE_BYTES : input.maxSourceBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw expectedToolError('invalid_argument', 'The streamed source byte limit is invalid.');
      }
      return { kind: 'source', source: input.desiredSource, replacements: 0, maxBytes: Math.min(maxBytes, MAX_STREAM_FILE_BYTES) };
    }
    if (input.desiredContent === undefined) throw expectedToolError('invalid_argument', 'Create content is missing.');
    const bytes = Buffer.from(input.desiredContent, 'utf8');
    if (bytes.byteLength > MAX_PATCH_FILE_BYTES) throw expectedToolError('limit', 'The created file exceeds the patch file limit.');
    return { kind: 'bytes', bytes, replacements: 0, maxBytes: MAX_PATCH_FILE_BYTES };
  }
  if (input.desiredSource !== undefined || input.maxSourceBytes !== undefined) {
    throw expectedToolError('invalid_argument', 'Only create mutations can use a streamed source.');
  }
  const current = await fence.inspect(binding.entryName, { includeContent: true, maxBytes: 8 * 1024 * 1024 });
  if (current?.content === undefined || current.digest !== binding.expectedDigest || binding.targetIdentity === undefined ||
    !primitive.sameIdentity(current.identity, binding.targetIdentity)) {
    throw expectedToolError('conflict', 'The update target changed before patch preparation.');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(current.content); }
  catch { throw expectedToolError('precondition', 'Only UTF-8 files can be patched.'); }
  let replacements = 0;
  for (const edit of input.edits ?? []) {
    throwIfAborted(input.signal);
    const count = countOccurrences(text, edit.oldText, input.signal);
    if (count === 0 || (count > 1 && !edit.replaceAll)) throw expectedToolError('conflict', 'A patch fragment is missing or ambiguous.');
    const applied = edit.replaceAll ? count : 1;
    const oldBytes = Buffer.byteLength(edit.oldText, 'utf8'); const newBytes = Buffer.byteLength(edit.newText, 'utf8');
    const currentBytes = Buffer.byteLength(text, 'utf8');
    const nextBytes = currentBytes + applied * (newBytes - oldBytes);
    if (!Number.isSafeInteger(nextBytes) || nextBytes < 0 || nextBytes > MAX_PATCH_FILE_BYTES) {
      throw expectedToolError('limit', 'The patched file exceeds the patch file limit.');
    }
    text = applyBoundedEdit(text, edit, applied, nextBytes, input.signal);
    replacements += applied;
  }
  return { kind: 'bytes', bytes: Buffer.from(text, 'utf8'), replacements, maxBytes: MAX_PATCH_FILE_BYTES };
}

function countOccurrences(text: string, needle: string, signal: AbortSignal): number {
  let count = 0; let offset = 0;
  while (offset <= text.length - needle.length) {
    if ((count & 1023) === 0) throwIfAborted(signal);
    const found = text.indexOf(needle, offset);
    if (found < 0) break;
    count += 1; offset = found + needle.length;
  }
  return count;
}

function applyBoundedEdit(
  text: string,
  edit: WorkspacePatchEdit,
  replacements: number,
  outputBytes: number,
  signal: AbortSignal,
): string {
  const output = Buffer.allocUnsafe(outputBytes); const replacement = Buffer.from(edit.newText, 'utf8');
  let sourceOffset = 0; let outputOffset = 0;
  for (let index = 0; index < replacements; index += 1) {
    if ((index & 1023) === 0) throwIfAborted(signal);
    const found = text.indexOf(edit.oldText, sourceOffset);
    if (found < 0) throw expectedToolError('conflict', 'The patch source changed while applying an edit.');
    const prefix = Buffer.from(text.slice(sourceOffset, found), 'utf8');
    prefix.copy(output, outputOffset); outputOffset += prefix.byteLength;
    replacement.copy(output, outputOffset); outputOffset += replacement.byteLength;
    sourceOffset = found + edit.oldText.length;
  }
  const suffix = Buffer.from(text.slice(sourceOffset), 'utf8'); suffix.copy(output, outputOffset); outputOffset += suffix.byteLength;
  if (outputOffset !== outputBytes) throw expectedToolError('external', 'The bounded patch size calculation was inconsistent.');
  return output.toString('utf8');
}

async function recoverTransaction(
  primitive: WorkspaceMutationPrimitive,
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  journal: WorkspaceMutationJournal,
  signal: AbortSignal,
): Promise<WorkspaceMutationResult> {
  throwIfAborted(signal);
  if (journal.protocol !== 'workspace-mutation-journal.v1' || journal.transactionName !== binding.transactionName ||
    journal.action !== binding.action || journal.expectedDigest !== binding.expectedDigest) {
    throw unknown(binding, 'Transaction journal does not match the prepared mutation.');
  }
  if (journal.streamed === true && binding.action !== 'create') {
    throw unknown(binding, 'The interrupted mutation has an invalid streamed-content marker.');
  }
  if (journal.phase === 'prepared' && binding.action !== 'delete') {
    await cleanupUnpublishedJournal(fence, binding);
    throw expectedToolError('conflict', `The interrupted ${binding.action} did not publish any content.`);
  }
  const recoveryMaxBytes = journal.streamed === true ? MAX_STREAM_FILE_BYTES : undefined;
  const target = await inspectWithMaxBytes(fence, binding.entryName, recoveryMaxBytes);
  const backup = await inspectWithMaxBytes(fence, binding.backupName, recoveryMaxBytes);
  const temporary = binding.action === 'delete' ? undefined : await inspectWithMaxBytes(fence, binding.temporaryName, recoveryMaxBytes);
  if (binding.action !== 'delete' && journal.phase !== 'prepared' && !isDigest(journal.desiredDigest)) {
    throw unknown(binding, 'The interrupted mutation has no valid completed-content digest.');
  }
  if (binding.action === 'delete') {
    if (target === undefined && backup !== undefined && backup.digest === binding.expectedDigest && binding.targetIdentity !== undefined &&
      primitive.sameIdentity(backup.identity, binding.targetIdentity)) {
      await fence.unlink(binding.backupName);
      return finishCommit(fence, binding, journal.phase, undefined, undefined);
    }
    if (target === undefined && backup === undefined && journal.phase !== 'prepared') return finishCommit(fence, binding, journal.phase, undefined, undefined);
    if (target?.digest === binding.expectedDigest && backup === undefined) {
      await fence.unlink(binding.transactionName);
      throw expectedToolError('conflict', 'The interrupted delete was rolled back before commit.');
    }
    throw unknown(binding, 'The interrupted delete cannot be resolved without overwriting another entry.');
  }
  if (journal.desiredDigest !== undefined && target?.digest === journal.desiredDigest) {
    return finishCommit(fence, binding, journal.phase, undefined, journal.desiredDigest, recoveryMaxBytes, journal.streamed === true);
  }
  if (journal.desiredDigest !== undefined && target === undefined && temporary?.digest === journal.desiredDigest &&
    (binding.action === 'create' || backup?.digest === binding.expectedDigest)) {
    await fence.linkNoReplace(binding.temporaryName, binding.entryName);
    await writePhase(fence, binding, journal.phase, 'published', journal.desiredDigest, journal.streamed === true);
    return finishCommit(fence, binding, 'published', undefined, journal.desiredDigest, recoveryMaxBytes, journal.streamed === true);
  }
  if (target === undefined && backup !== undefined && backup.digest === binding.expectedDigest && binding.targetIdentity !== undefined &&
    primitive.sameIdentity(backup.identity, binding.targetIdentity)) {
    await fence.linkNoReplace(binding.backupName, binding.entryName);
    await cleanupRollback(fence, binding, journal.phase, journal.desiredDigest);
    throw expectedToolError('conflict', 'The interrupted update was rolled back.');
  }
  if (binding.targetIdentity !== undefined && target !== undefined && target.digest === binding.expectedDigest &&
    primitive.sameIdentity(target.identity, binding.targetIdentity)) {
    if (backup !== undefined && !primitive.sameIdentity(backup.identity, binding.targetIdentity)) {
      throw unknown(binding, 'Rollback backup identity is inconsistent.');
    }
    await cleanupRollback(fence, binding, journal.phase, journal.desiredDigest);
    throw expectedToolError('conflict', 'The interrupted update was rolled back.');
  }
  throw unknown(binding, 'The interrupted mutation cannot be resolved without overwriting another entry.');
}

async function finishCommit(
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  expectedPhase: WorkspaceMutationJournal['phase'],
  replacements?: number,
  desiredDigest?: string,
  maxBytes?: number,
  streamed?: boolean,
): Promise<WorkspaceMutationResult> {
  if (binding.action !== 'delete' && await inspectWithMaxBytes(fence, binding.temporaryName, maxBytes)) await fence.unlink(binding.temporaryName);
  if (await inspectWithMaxBytes(fence, binding.backupName, maxBytes)) await fence.unlink(binding.backupName);
  await writePhase(fence, binding, expectedPhase, 'committed', desiredDigest, streamed);
  const target = await inspectWithMaxBytes(fence, binding.entryName, maxBytes);
  await fence.unlink(binding.transactionName);
  await fence.sync();
  return Object.freeze({
    status: 'ok', summary: `${binding.action} completed for ${binding.displayPath}.`, action: binding.action,
    canonicalPath: binding.canonicalPath, displayPath: binding.displayPath,
    ...(binding.expectedDigest === undefined ? {} : { previousDigest: binding.expectedDigest }),
    ...(target === undefined ? { deleted: true } : { digest: target.digest, sizeBytes: target.sizeBytes, identity: target.identity }),
    ...(replacements === undefined ? {} : { replacements }),
  });
}

async function rollbackMovedEntry(
  primitive: WorkspaceMutationPrimitive,
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  desiredDigest?: string,
): Promise<void> {
  try {
    const backup = await fence.inspect(binding.backupName);
    if (backup === undefined) throw unknown(binding, 'Rollback backup is missing.');
    if (await fence.inspect(binding.entryName)) throw unknown(binding, 'A concurrent entry prevents rollback; backup was preserved.');
    await fence.linkNoReplace(binding.backupName, binding.entryName);
    const restored = await fence.inspect(binding.entryName);
    if (restored === undefined || !primitive.sameIdentity(restored.identity, backup.identity)) throw unknown(binding, 'Rollback publication could not be verified.');
    await cleanupRollback(fence, binding, 'target_backed_up', desiredDigest);
  } catch (error) {
    throw unknown(binding, `Rollback cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function writePhase(
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  expectedPhase: 'missing' | WorkspaceMutationJournal['phase'],
  phase: WorkspaceMutationJournal['phase'],
  desiredDigest?: string,
  streamed?: boolean,
): Promise<void> {
  await fence.writeJournal(binding.transactionName, expectedPhase, Object.freeze({
    protocol: 'workspace-mutation-journal.v1', transactionName: binding.transactionName, action: binding.action, phase,
    ...(binding.expectedDigest === undefined ? {} : { expectedDigest: binding.expectedDigest }),
    ...(desiredDigest === undefined ? {} : { desiredDigest }),
    ...(streamed === true ? { streamed: true as const } : {}),
  }));
  await fence.sync();
}

async function cleanupRollback(
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
  expectedPhase: WorkspaceMutationJournal['phase'],
  desiredDigest?: string,
  maxBytes?: number,
  streamed?: boolean,
): Promise<void> {
  try {
    await writePhase(fence, binding, expectedPhase, 'rolled_back', desiredDigest, streamed);
    if (await inspectWithMaxBytes(fence, binding.temporaryName, maxBytes)) await fence.unlink(binding.temporaryName);
    if (await inspectWithMaxBytes(fence, binding.backupName, maxBytes)) await fence.unlink(binding.backupName);
    await fence.unlink(binding.transactionName);
    await fence.sync();
  } catch (error) {
    throw unknown(binding, `Rollback cleanup is incomplete: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function cleanupUnpublishedJournal(
  fence: WorkspaceParentMutationFence,
  binding: WorkspaceMutationBinding,
): Promise<void> {
  try {
    await fence.unlink(binding.transactionName);
    await fence.sync();
  } catch (error) {
    throw unknown(binding, `Unpublished Journal cleanup is incomplete: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function inspectWithMaxBytes(
  fence: WorkspaceParentMutationFence,
  name: string,
  maxBytes: number | undefined,
): Promise<WorkspaceMutationSnapshot | undefined> {
  return maxBytes === undefined ? fence.inspect(name) : fence.inspect(name, { maxBytes });
}

function assertBinding(binding: WorkspaceMutationBinding, revision: string): void {
  if (binding.protocol !== 'workspace-mutation-binding.v1' || binding.adapterRevision !== revision) {
    throw expectedToolError('precondition', 'The workspace mutation adapter revision changed.');
  }
}
function digest(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function unknown(binding: WorkspaceMutationBinding, message: string): Error { return expectedToolError('external', `${message} Transaction metadata: ${binding.transactionName}.`, { outcome: 'unknown' }); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) { const error = new Error('Workspace mutation was cancelled.'); error.name = 'AbortError'; throw error; } }
