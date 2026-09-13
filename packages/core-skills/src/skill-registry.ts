import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSkillDocument, parseSkillMetadata } from './skill-parser.js';
import { parseSkillInvocation } from './skill-invocation.js';
import { searchSkillCatalog } from './skill-search.js';
import { skillCapabilityRequirements } from './capability-requirements.js';
import { compareUnicodeCodePoints } from './canonical-text-order.js';
import { SKILL_SCOPES } from './types.js';
import type {
  ActivatedSkillInvocation,
  SkillCatalogEntry,
  SkillCapabilityResolver,
  SkillBundleLimits,
  SkillConflict,
  SkillDescriptor,
  SkillDirectorySource,
  SkillDocument,
  SkillIssueCode,
  SkillListOptions,
  SkillLoadIssue,
  SkillLookup,
  SkillOverlay,
  SkillRefreshResult,
  SkillRevisionRef,
  SkillRevisionManifest,
  SkillResourceManifestEntry,
  SkillRegistryOptions,
  SkillSearchOptions,
  SkillSearchResult,
  SkillScope,
  SkillWatcher,
  SkillWatchOptions,
} from './types.js';

// SKILL.md may be retained by the Skill Tool, whose explicit per-artifact
// contract is 4 MiB. Keep discovery/load and Runtime retention consistent.
const DEFAULT_RESOURCE_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_BUNDLE_FILES = 512;
const DEFAULT_BUNDLE_BYTES = 16 * 1_024 * 1_024;
const MAX_REVISION_MANIFEST_BYTES = 1 * 1_024 * 1_024;
const MAX_BUNDLE_CAPTURE_ATTEMPTS = 3;
const SCOPE_RANK: Readonly<Record<SkillScope, number>> = {
  system: 0,
  user: 1,
  project: 2,
  session: 3,
};

type DiskOrigin = {
  kind: 'disk';
  content: string;
};

type OverlayOrigin = {
  kind: 'overlay';
  content: string;
};

type SkillCandidate = {
  descriptor: SkillDescriptor;
  origin: DiskOrigin | OverlayOrigin;
  manifest: SkillRevisionManifest;
  resources: ReadonlyMap<string, Buffer>;
};

type ResolvedBundleLimits = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

type CapturedFileState = Readonly<{
  requestedPath: string;
  canonicalPath: string;
  information: Awaited<ReturnType<typeof lstat>>;
  entry: SkillResourceManifestEntry;
}>;

type CapturedDirectoryState = Readonly<{
  path: string;
  information: Awaited<ReturnType<typeof lstat>>;
  entriesSignature: string;
}>;

class SkillBundleChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillBundleChangedError';
  }
}

type RegistrySnapshot = {
  selected: Map<string, SkillCandidate>;
  selectedByScope: Map<string, SkillCandidate>;
  conflicts: SkillConflict[];
};

export class SkillRegistry {
  private sources: SkillDirectorySource[];
  private readonly capabilityResolver: SkillCapabilityResolver | undefined;
  private readonly revisionCachePath: string | undefined;
  private readonly bundleLimits: ResolvedBundleLimits;
  private diskCandidates: SkillCandidate[] = [];
  private overlayCandidates: SkillCandidate[] = [];
  private diskIssues: SkillLoadIssue[] = [];
  private overlayIssues: SkillLoadIssue[] = [];
  private snapshot: RegistrySnapshot = emptySnapshot();
  private revision = 0;
  private signature = '';
  private sourcesRevision = 0;
  private refreshInFlight: Promise<SkillRefreshResult> | undefined;
  private fileWatchers = new Map<string, FSWatcher>();
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchPoller: ReturnType<typeof setInterval> | undefined;
  private watchOptions: SkillWatchOptions | undefined;

  constructor(options: SkillRegistryOptions = {}) {
    this.sources = cloneSources(options.sources ?? []);
    this.capabilityResolver = options.capabilityResolver;
    this.revisionCachePath = options.revisionCachePath
      ? resolve(options.revisionCachePath)
      : undefined;
    this.bundleLimits = resolveBundleLimits(options.bundleLimits);
    if (options.sessionOverlay) this.replaceSessionOverlay(options.sessionOverlay);
  }

  setSources(sources: readonly SkillDirectorySource[]): void {
    this.sources = cloneSources(sources);
    this.sourcesRevision += 1;
    if (this.watchOptions) this.syncFileWatchers();
  }

  /**
   * Creates an isolated Session view from the latest shared disk snapshot.
   *
   * The returned registry owns its overlay and snapshot state. System, user,
   * and Project candidates are reused as immutable metadata, so creating a
   * Session view does not rescan the filesystem and cannot mutate another
   * Session's overlay.
   */
  createSessionView(overlays: readonly SkillOverlay[] = []): SkillRegistry {
    const view = new SkillRegistry({
      sources: this.sources,
      ...(this.capabilityResolver === undefined
        ? {}
        : { capabilityResolver: this.capabilityResolver }),
      ...(this.revisionCachePath === undefined
        ? {}
        : { revisionCachePath: this.revisionCachePath }),
      bundleLimits: this.bundleLimits,
    });
    view.diskCandidates = this.diskCandidates;
    view.diskIssues = this.diskIssues;
    view.replaceSessionOverlay(overlays);
    return view;
  }

  /**
   * Captures the registry exactly as it is currently visible to a Turn.
   *
   * Unlike `createSessionView`, this preserves the current Session overlay.
   * Candidate arrays and the resolved lookup maps are copied, so later disk
   * refreshes or overlay replacement on the source registry cannot change the
   * captured view. Revision resources and capability checks retain the same
   * cache and resolver configuration without rescanning the filesystem.
   */
  captureSnapshotView(): SkillRegistry {
    const diskCandidates = [...this.diskCandidates];
    const overlayCandidates = [...this.overlayCandidates];
    const capturedCandidates = [...diskCandidates, ...overlayCandidates];
    const availabilityByRevision = this.capabilityResolver === undefined
      ? undefined
      : new Map(
          capturedCandidates.map(({ descriptor }) => [
            descriptor.revisionRef.revisionId,
            this.isAvailable(descriptor),
          ]),
        );
    const capturedCapabilityResolver: SkillCapabilityResolver | undefined =
      availabilityByRevision === undefined
        ? undefined
        : (_requirements, descriptor) =>
            availabilityByRevision.get(descriptor.revisionRef.revisionId) === true;
    const view = new SkillRegistry({
      sources: this.sources,
      ...(capturedCapabilityResolver === undefined
        ? {}
        : { capabilityResolver: capturedCapabilityResolver }),
      ...(this.revisionCachePath === undefined
        ? {}
        : { revisionCachePath: this.revisionCachePath }),
      bundleLimits: this.bundleLimits,
    });
    view.diskCandidates = diskCandidates;
    view.overlayCandidates = overlayCandidates;
    view.diskIssues = this.diskIssues.map((issue) => ({ ...issue }));
    view.overlayIssues = this.overlayIssues.map((issue) => ({ ...issue }));
    view.snapshot = resolveCandidates(capturedCandidates);
    view.revision = this.revision;
    view.signature = this.signature;
    view.sourcesRevision = this.sourcesRevision;
    return view;
  }

  /** Current shared/directory snapshot revision, for view cache invalidation. */
  currentRevision(): number {
    return this.revision;
  }

  /**
   * Replaces the Session-only in-memory SKILL.md overlay.
   *
   * Overlay documents follow the same Agent Skills format. They are never
   * merged into Project scope and disappear when the owning Session runtime is
   * discarded.
   */
  replaceSessionOverlay(overlays: readonly SkillOverlay[]): SkillRefreshResult {
    const candidates: SkillCandidate[] = [];
    const issues: SkillLoadIssue[] = [];
    const baseOrder = this.sources.length;

    overlays.forEach((overlay, index) => {
      const provisionalPath = overlay.sourcePath ?? `session-overlay/${String(index + 1)}/SKILL.md`;
      let issuePath = provisionalPath;
      try {
        const provisional = parseSkillMetadata(overlay.content, {
          scope: 'session',
          sourceId: 'session-overlay',
          sourcePath: provisionalPath,
          bundleRoot: dirname(provisionalPath),
          sourceOrder: baseOrder + index,
          ...(overlay.sourcePath?.endsWith('SKILL.md')
            ? { expectedName: basename(dirname(overlay.sourcePath)) }
            : {}),
        });
        const sourcePath = overlay.sourcePath ?? `session-overlay/${provisional.name}/SKILL.md`;
        issuePath = sourcePath;
        const bundleRoot = dirname(sourcePath);
        const descriptor =
          sourcePath === provisionalPath
            ? provisional
            : parseSkillMetadata(overlay.content, {
                scope: 'session',
                sourceId: 'session-overlay',
                sourcePath,
                bundleRoot,
                sourceOrder: baseOrder + index,
                expectedName: provisional.name,
              });
        skillCapabilityRequirements(descriptor.metadata);
        const overlayBytes = Buffer.from(overlay.content, 'utf8');
        assertBundleByteLimits(overlayBytes.byteLength, this.bundleLimits);
        const manifest = overlayRevisionManifest(descriptor, overlay.content);
        candidates.push({
          descriptor: descriptorWithManifest(descriptor, manifest),
          origin: { kind: 'overlay', content: overlay.content },
          manifest,
          resources: new Map([['SKILL.md', overlayBytes]]),
        });
      } catch (error) {
        issues.push({
          code: classifyIssue(error),
          scope: 'session',
          path: issuePath,
          message: errorMessage(error),
        });
      }
    });

    this.overlayCandidates = candidates;
    this.overlayIssues = issues;
    return this.rebuildSnapshot();
  }

  async refresh(): Promise<SkillRefreshResult> {
    if (this.refreshInFlight) return await this.refreshInFlight;
    const refresh = this.refreshFromDisk();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  list(options: SkillListOptions = {}): SkillCatalogEntry[] {
    const values = options.scope
      ? [...this.snapshot.selectedByScope.values()].filter(
          ({ descriptor }) => descriptor.scope === options.scope,
        )
      : [...this.snapshot.selected.values()];
    return values
      .filter((candidate) => this.isAvailable(candidate.descriptor, options.capabilityResolver))
      .map(({ descriptor }) => toCatalogEntry(descriptor))
      .sort(compareCatalogEntries);
  }

  /**
   * Returns the Tier-1 catalog intended for model context. It deliberately
   * omits paths, hashes, metadata and Skill instructions.
   */
  catalogForModel(options: SkillListOptions = {}): SkillCatalogEntry[] {
    return this.list(options);
  }

  get(
    lookup: string | SkillLookup,
    options: Pick<SkillListOptions, 'capabilityResolver'> = {},
  ): SkillCatalogEntry | undefined {
    const candidate = this.findCandidate(normalizeLookup(lookup));
    return candidate && this.isAvailable(candidate.descriptor, options.capabilityResolver)
      ? toCatalogEntry(candidate.descriptor)
      : undefined;
  }

  inspect(lookup: string | SkillLookup): SkillDescriptor | undefined {
    const candidate = this.findCandidate(normalizeLookup(lookup));
    return candidate ? cloneDescriptor(candidate.descriptor) : undefined;
  }

  async load(
    lookup: string | SkillLookup,
    options: Pick<SkillListOptions, 'capabilityResolver'> = {},
  ): Promise<SkillDocument> {
    const normalized = normalizeLookup(lookup);
    const candidate = this.findCandidate(normalized);
    if (!candidate) {
      const scope = normalized.scope ? ` in ${normalized.scope} scope` : '';
      throw new Error(`Skill "${normalized.name}" was not found${scope}.`);
    }
    if (!this.isAvailable(candidate.descriptor, options.capabilityResolver)) {
      throw new Error(
        `Skill "${normalized.name}" requires unavailable capabilities: ${skillCapabilityRequirements(
          candidate.descriptor.metadata,
        )
          .map((requirement) => requirement.capabilityId)
          .join(', ')}.`,
      );
    }

    if (candidate.origin.kind === 'overlay') await this.cacheRevisions([candidate]);
    return parseSkillDocument(candidate.origin.content, descriptorContext(candidate.descriptor));
  }

  /** Loads one portable, content-addressed Skill revision exactly. */
  async loadRevision(revisionRef: SkillRevisionRef): Promise<SkillDocument> {
    const capturedRevision = captureRevisionRef(revisionRef);
    const local = this.findRevisionCandidate(capturedRevision);
    if (local) {
      if (local.origin.kind === 'overlay') await this.cacheRevisions([local]);
      return parseSkillDocument(local.origin.content, revisionContext(capturedRevision));
    }

    const cachedManifest = await this.readCachedManifest(capturedRevision);
    if (cachedManifest !== undefined) {
      const cached = await this.readCachedBlob(capturedRevision.contentDigest);
      return parseSkillDocument(decodeUtf8Document(cached), revisionContext(capturedRevision));
    }

    const live = await this.rediscoverRevision(capturedRevision);
    if (!live) throw new Error(`Skill revision ${capturedRevision.revisionId} is unavailable.`);
    return parseSkillDocument(live.origin.content, revisionContext(capturedRevision));
  }

  /** Reads a resource from exactly the frozen Skill bundle revision. */
  async readRevisionResource(
    revisionRef: SkillRevisionRef,
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<string> {
    const capturedRevision = captureRevisionRef(revisionRef);
    const normalizedPath = normalizeResourcePath(relativePath);
    const maxBytes = validateResourceReadLimit(options.maxBytes);
    const local = this.findRevisionCandidate(capturedRevision);
    if (local) {
      if (local.origin.kind === 'overlay') await this.cacheRevisions([local]);
      const bytes = local.resources.get(normalizedPath);
      if (!bytes) throw new Error(`Skill revision resource was not found: ${normalizedPath}.`);
      if (bytes.byteLength > maxBytes) throw resourceReadTooLarge(maxBytes);
      return decodeUtf8Resource(bytes);
    }

    let manifest = await this.readCachedManifest(capturedRevision);
    let live: SkillCandidate | undefined;
    if (!manifest) {
      live = await this.rediscoverRevision(capturedRevision);
      if (!live) throw new Error(`Skill revision ${capturedRevision.revisionId} is unavailable.`);
      manifest = live.manifest;
    }
    const entry = manifest.resources.find(({ path }) => path === normalizedPath);
    if (!entry) throw new Error(`Skill revision resource was not found: ${normalizedPath}.`);
    if (entry.byteSize > maxBytes) throw resourceReadTooLarge(maxBytes);
    const bytes = live?.resources.get(normalizedPath) ?? await this.readCachedBlob(entry.contentDigest);
    if (!bytes) throw new Error(`Skill revision resource was not found: ${normalizedPath}.`);
    if (bytes.byteLength !== entry.byteSize) throw new Error('Skill revision cache is corrupt.');
    assertBytesDigest(bytes, entry.contentDigest);
    return decodeUtf8Resource(bytes);
  }

  search(query: string, options: SkillSearchOptions = {}): SkillSearchResult[] {
    return searchSkillCatalog(this.list(options), query, options.limit);
  }

  async invoke(input: string): Promise<ActivatedSkillInvocation | undefined> {
    const invocation = parseSkillInvocation(input);
    if (!invocation) return undefined;
    return { ...invocation, skill: await this.load(invocation) };
  }

  issues(): SkillLoadIssue[] {
    return [...this.diskIssues, ...this.overlayIssues].map((issue) => ({ ...issue }));
  }

  conflicts(): SkillConflict[] {
    return this.snapshot.conflicts.map(cloneConflict);
  }

  /**
   * Watches each configured scope root and each discovered Skill bundle.
   * Watching direct directories avoids the platform differences of recursive
   * fs.watch. A low-frequency poll is retained as a correctness fallback for
   * network and Windows filesystems that may drop rename/delete events.
   */
  watch(options: SkillWatchOptions = {}): SkillWatcher {
    if (this.watchOptions) throw new Error('SkillRegistry is already watching for changes.');
    const debounceMs = options.debounceMs ?? 75;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 10) {
      throw new Error('Skill watch debounceMs must be an integer of at least 10ms.');
    }
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    if (
      pollIntervalMs !== false &&
      (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50)
    ) {
      throw new Error('Skill watch pollIntervalMs must be false or an integer of at least 50ms.');
    }

    this.watchOptions = { ...options, debounceMs, pollIntervalMs };
    this.syncFileWatchers();
    if (pollIntervalMs !== false) {
      this.watchPoller = setInterval(() => {
        this.scheduleWatchedRefresh();
      }, pollIntervalMs);
      this.watchPoller.unref();
    }

    return {
      close: () => {
        this.stopWatching();
      },
    };
  }

  stopWatching(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (this.watchPoller) {
      clearInterval(this.watchPoller);
      this.watchPoller = undefined;
    }
    for (const watcher of this.fileWatchers.values()) watcher.close();
    this.fileWatchers.clear();
    this.watchOptions = undefined;
  }

  private async refreshFromDisk(): Promise<SkillRefreshResult> {
    for (;;) {
      const sourcesRevision = this.sourcesRevision;
      const sources = this.sources;
      const discovered = await Promise.all(
        sources.map((source, sourceOrder) =>
          discoverSource(source, sourceOrder, this.bundleLimits),
        ),
      );
      if (sourcesRevision !== this.sourcesRevision) continue;
      const candidates = discovered.flatMap((result) => result.candidates);
      await this.cacheRevisions(candidates);
      if (sourcesRevision !== this.sourcesRevision) continue;
      this.diskCandidates = candidates;
      this.diskIssues = discovered.flatMap((result) => result.issues);
      return this.rebuildSnapshot();
    }
  }

  private rebuildSnapshot(): SkillRefreshResult {
    this.snapshot = resolveCandidates([...this.diskCandidates, ...this.overlayCandidates]);
    const nextSignature = registrySignature(
      this.snapshot,
      [...this.diskCandidates, ...this.overlayCandidates],
      this.diskIssues,
      this.overlayIssues,
    );
    const changed = nextSignature !== this.signature;
    if (changed) {
      this.signature = nextSignature;
      this.revision += 1;
    }
    return {
      changed,
      revision: this.revision,
      skills: this.list(),
      issues: this.issues(),
      conflicts: this.conflicts(),
    };
  }

  private findCandidate(lookup: SkillLookup): SkillCandidate | undefined {
    return lookup.scope
      ? this.snapshot.selectedByScope.get(scopeKey(lookup.scope, lookup.name))
      : this.snapshot.selected.get(lookup.name);
  }

  private isAvailable(descriptor: SkillDescriptor, override?: SkillCapabilityResolver): boolean {
    const resolver = override ?? this.capabilityResolver;
    if (!resolver) return true;
    return resolver(skillCapabilityRequirements(descriptor.metadata), descriptor);
  }

  private findRevisionCandidate(revisionRef: SkillRevisionRef): SkillCandidate | undefined {
    return [...this.diskCandidates, ...this.overlayCandidates].find(
      ({ descriptor }) => revisionRefsEqual(descriptor.revisionRef, revisionRef),
    );
  }

  private async cacheRevisions(candidates: readonly SkillCandidate[]): Promise<void> {
    if (!this.revisionCachePath) return;
    await mkdir(this.revisionCachePath, { recursive: true });
    await Promise.all(
      candidates.map(async ({ descriptor, origin, manifest, resources }) => {
        if (digestSkillContent(origin.content) !== descriptor.contentDigest) return;
        await Promise.all(
          [...resources.values()].map(
            async (bytes) =>
              await publishBlob(this.revisionCachePath!, digestSkillBytes(bytes), bytes),
          ),
        );
        await publishManifest(this.revisionCachePath!, manifest, this.bundleLimits);
      }),
    );
  }

  private async readCachedManifest(
    revisionRef: SkillRevisionRef,
  ): Promise<SkillRevisionManifest | undefined> {
    if (!this.revisionCachePath) return undefined;
    try {
      const bytes = await readCacheEntry(
        this.revisionCachePath,
        'manifests',
        `${revisionRef.revisionId}.json`,
        MAX_REVISION_MANIFEST_BYTES,
      );
      const manifest = parseCachedManifest(bytes.toString('utf8'), this.bundleLimits);
      if (!revisionRefsEqual(manifest.revisionRef, revisionRef)) {
        throw new Error('Skill revision reference does not match its trusted manifest identity.');
      }
      return manifest;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async readCachedBlob(contentDigest: string): Promise<Buffer> {
    if (!this.revisionCachePath) throw new Error('Skill revision cache is not configured.');
    let bytes: Buffer;
    try {
      bytes = await readCacheEntry(
        this.revisionCachePath,
        'blobs',
        contentDigest,
        this.bundleLimits.maxFileBytes,
      );
    } catch (error) {
      if (isMissing(error)) throw new Error('Skill revision cache is incomplete.', { cause: error });
      throw error;
    }
    if (digestSkillBytes(bytes) !== contentDigest) throw new Error('Skill revision cache is corrupt.');
    return bytes;
  }

  private async rediscoverRevision(
    revisionRef: SkillRevisionRef,
  ): Promise<SkillCandidate | undefined> {
    for (;;) {
      const sourcesRevision = this.sourcesRevision;
      const sources = this.sources;
      const discovered = await Promise.all(
        sources.map((source, sourceOrder) =>
          discoverSource(source, sourceOrder, this.bundleLimits),
        ),
      );
      if (sourcesRevision !== this.sourcesRevision) continue;
      return discovered
        .flatMap(({ candidates }) => candidates)
        .find(({ descriptor }) => revisionRefsEqual(descriptor.revisionRef, revisionRef));
    }
  }

  private syncFileWatchers(): void {
    if (!this.watchOptions) return;

    const paths = new Set([
      ...this.sources.map(({ path }) => path),
      ...this.diskCandidates.map(({ descriptor }) => descriptor.bundleRoot),
    ]);
    for (const [path, watcher] of this.fileWatchers) {
      if (paths.has(path)) continue;
      watcher.close();
      this.fileWatchers.delete(path);
    }
    for (const path of paths) {
      if (this.fileWatchers.has(path)) continue;
      try {
        const watcher = watchFileSystem(path, { persistent: false }, () => {
          this.scheduleWatchedRefresh();
        });
        watcher.on('error', (error) => {
          watcher.close();
          this.fileWatchers.delete(path);
          this.reportWatchError(error);
        });
        this.fileWatchers.set(path, watcher);
      } catch (error) {
        if (!isMissing(error)) this.reportWatchError(error);
      }
    }
  }

  private scheduleWatchedRefresh(): void {
    if (!this.watchOptions) return;
    // Do not keep postponing refresh when a filesystem emits an event storm
    // (Windows commonly does this while a watched directory is deleted).
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.refresh()
        .then(async (result) => {
          this.syncFileWatchers();
          if (result.changed) await this.watchOptions?.onChange?.(result);
        })
        .catch((error: unknown) => {
          this.reportWatchError(error);
        });
    }, this.watchOptions.debounceMs);
    this.watchTimer.unref();
  }

  private reportWatchError(error: unknown): void {
    const handler = this.watchOptions?.onError;
    if (handler) void Promise.resolve(handler(error)).catch(() => undefined);
  }
}

/**
 * Reads the resource currently present in a live Skill bundle.
 * Turn-stable callers must use `SkillRegistry.readRevisionResource()` with
 * the Turn's captured revision reference instead.
 */
export async function readSkillTextResource(
  skill: SkillDescriptor,
  relativePath: string,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = validateResourceReadLimit(options.maxBytes);
  const normalizedPath = normalizeResourcePath(relativePath);

  const root = await realpath(skill.bundleRoot);
  await assertPathSegmentsAreRealDirectories(root, normalizedPath);
  const requested = resolve(root, ...normalizedPath.split('/'));
  assertWithin(root, requested);
  const requestedInformation = await lstat(requested);
  if (requestedInformation.isSymbolicLink()) {
    throw new Error('Skill resource path must not be a symbolic link.');
  }
  const target = await realpath(requested);
  assertWithin(root, target);
  const information = await lstat(target);
  if (!information.isFile()) throw new Error('Skill resource path must refer to a file.');
  if (information.size > maxBytes) {
    throw new Error(`Skill resource exceeds the ${String(maxBytes)} byte limit.`);
  }
  return decodeUtf8Resource(await readStableFile(target, information));
}

async function discoverSource(
  source: SkillDirectorySource,
  sourceOrder: number,
  limits: ResolvedBundleLimits = resolveBundleLimits(),
): Promise<{ candidates: SkillCandidate[]; issues: SkillLoadIssue[] }> {
  const sourceId = source.id?.trim() || `${source.scope}:${sourceOrder}`;
  let entries;
  try {
    entries = await readdir(source.path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { candidates: [], issues: [] };
    return {
      candidates: [],
      issues: [
        {
          code: 'directory-unavailable',
          scope: source.scope,
          path: source.path,
          message: errorMessage(error),
        },
      ],
    };
  }

  const ownDocument = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md');
  const rootSymlinkIssues: SkillLoadIssue[] = entries
    .filter((entry) => entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map((entry) => ({
      code: 'invalid-document',
      scope: source.scope,
      path: join(source.path, entry.name, 'SKILL.md'),
      message: 'Skill bundle root must not be a symbolic link.',
    }));
  const paths = ownDocument
    ? [
        {
          bundleRoot: source.path,
          documentPath: join(source.path, 'SKILL.md'),
          expectedName: basename(resolve(source.path)),
        },
      ]
    : entries
        .filter(
          (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'),
        )
        .sort((left, right) => compareUnicodeCodePoints(left.name, right.name))
        .map((entry) => ({
          bundleRoot: join(source.path, entry.name),
          documentPath: join(source.path, entry.name, 'SKILL.md'),
          expectedName: entry.name,
        }));

  const candidates: SkillCandidate[] = [];
  const issues: SkillLoadIssue[] = rootSymlinkIssues;
  for (const candidatePath of paths) {
    try {
      const sourceRoot = await realpath(source.path);
      const bundleRoot = await realpath(candidatePath.bundleRoot);
      assertWithin(sourceRoot, bundleRoot);
      const documentPath = await realpath(candidatePath.documentPath);
      assertWithin(bundleRoot, documentPath);
      if ((await lstat(candidatePath.bundleRoot)).isSymbolicLink()) {
        throw new Error('Skill bundle root must not be a symbolic link.');
      }
      if ((await lstat(candidatePath.documentPath)).isSymbolicLink()) {
        throw new Error('SKILL.md must not be a symbolic link.');
      }
      const bundle = await captureBundle(bundleRoot, limits);
      const documentBytes = bundle.resources.get('SKILL.md');
      if (!documentBytes) throw new Error('Skill bundle must contain SKILL.md.');
      const information = await lstat(documentPath);
      if (!information.isFile()) continue;
      const content = decodeUtf8Document(documentBytes);
      const contentDigest = digestSkillBytes(documentBytes);
      const preliminary = parseSkillMetadata(content, {
        scope: source.scope,
        sourceId,
        sourcePath: documentPath,
        bundleRoot,
        sourceOrder,
        expectedName: candidatePath.expectedName,
        modifiedAtMs: information.mtimeMs,
        contentDigest,
      });
      skillCapabilityRequirements(preliminary.metadata);
      const manifest = createRevisionManifest(preliminary, bundle.entries);
      const descriptor = descriptorWithManifest(preliminary, manifest);
      candidates.push({
        descriptor,
        origin: { kind: 'disk', content },
        manifest,
        resources: bundle.resources,
      });
    } catch (error) {
      if (isMissing(error)) continue;
      issues.push({
        code: classifyIssue(error),
        scope: source.scope,
        path: candidatePath.documentPath,
        message: errorMessage(error),
      });
    }
  }
  return { candidates, issues };
}

function resolveCandidates(candidates: SkillCandidate[]): RegistrySnapshot {
  const grouped = new Map<string, SkillCandidate[]>();
  const groupedByScope = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const byName = grouped.get(candidate.descriptor.name) ?? [];
    byName.push(candidate);
    grouped.set(candidate.descriptor.name, byName);

    const key = scopeKey(candidate.descriptor.scope, candidate.descriptor.name);
    const scoped = groupedByScope.get(key) ?? [];
    scoped.push(candidate);
    groupedByScope.set(key, scoped);
  }

  const selected = new Map<string, SkillCandidate>();
  const selectedByScope = new Map<string, SkillCandidate>();
  const conflicts: SkillConflict[] = [];
  for (const [name, values] of grouped) {
    const ordered = [...values].sort(compareCandidates);
    const winner = ordered[0]!;
    selected.set(name, winner);
    if (ordered.length > 1) {
      conflicts.push({
        name,
        selected: toConflictEntry(winner.descriptor),
        shadowed: ordered.slice(1).map(({ descriptor }) => toConflictEntry(descriptor)),
      });
    }
  }
  for (const [key, values] of groupedByScope) {
    selectedByScope.set(key, [...values].sort(compareCandidates)[0]!);
  }
  conflicts.sort((left, right) => compareUnicodeCodePoints(left.name, right.name));
  return { selected, selectedByScope, conflicts };
}

function compareCandidates(left: SkillCandidate, right: SkillCandidate): number {
  const scope = SCOPE_RANK[right.descriptor.scope] - SCOPE_RANK[left.descriptor.scope];
  if (scope !== 0) return scope;
  const source = right.descriptor.sourceOrder - left.descriptor.sourceOrder;
  if (source !== 0) return source;
  return compareUnicodeCodePoints(right.descriptor.sourcePath, left.descriptor.sourcePath);
}

function compareCatalogEntries(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
  return compareUnicodeCodePoints(left.name, right.name) || compareUnicodeCodePoints(left.scope, right.scope);
}

function normalizeLookup(lookup: string | SkillLookup): SkillLookup {
  if (typeof lookup !== 'string') return lookup;
  return { name: lookup };
}

function toCatalogEntry(descriptor: SkillDescriptor): SkillCatalogEntry {
  return {
    name: descriptor.name,
    description: descriptor.description,
    scope: descriptor.scope,
  };
}

function toConflictEntry(descriptor: SkillDescriptor) {
  return {
    ...toCatalogEntry(descriptor),
    sourceId: descriptor.sourceId,
    sourcePath: descriptor.sourcePath,
  };
}

function cloneDescriptor(descriptor: SkillDescriptor): SkillDescriptor {
  return {
    ...descriptor,
    metadata: { ...descriptor.metadata },
    ...(descriptor.allowedTools === undefined ? {} : { allowedTools: [...descriptor.allowedTools] }),
    revisionRef: Object.freeze({ ...descriptor.revisionRef }),
    extensions: { ...descriptor.extensions },
  };
}

function cloneConflict(conflict: SkillConflict): SkillConflict {
  return {
    name: conflict.name,
    selected: { ...conflict.selected },
    shadowed: conflict.shadowed.map((entry) => ({ ...entry })),
  };
}

function cloneSources(sources: readonly SkillDirectorySource[]): SkillDirectorySource[] {
  return sources.map((source) => ({
    scope: source.scope,
    path: resolve(source.path),
    ...(source.id === undefined ? {} : { id: source.id }),
  }));
}

function descriptorContext(descriptor: SkillDescriptor) {
  return {
    scope: descriptor.scope,
    sourceId: descriptor.sourceId,
    sourcePath: descriptor.sourcePath,
    bundleRoot: descriptor.bundleRoot,
    sourceOrder: descriptor.sourceOrder,
    expectedName: descriptor.name,
    ...(descriptor.modifiedAtMs === undefined ? {} : { modifiedAtMs: descriptor.modifiedAtMs }),
    contentDigest: descriptor.contentDigest,
    revisionRef: descriptor.revisionRef,
  };
}

function emptySnapshot(): RegistrySnapshot {
  return {
    selected: new Map(),
    selectedByScope: new Map(),
    conflicts: [],
  };
}

function registrySignature(
  snapshot: RegistrySnapshot,
  candidates: SkillCandidate[],
  diskIssues: SkillLoadIssue[],
  overlayIssues: SkillLoadIssue[],
): string {
  const entries = candidates
    .map(({ descriptor }) => [
      descriptor.name,
      descriptor.description,
      descriptor.scope,
      descriptor.sourceId,
      descriptor.sourcePath,
      descriptor.modifiedAtMs ?? 0,
      descriptor.contentDigest,
      descriptor.revisionRef.revisionId,
    ])
    .sort(
      (left, right) =>
        compareUnicodeCodePoints(String(left[0]), String(right[0])) ||
        compareUnicodeCodePoints(String(left[3]), String(right[3])) ||
        compareUnicodeCodePoints(String(left[4]), String(right[4])),
    );
  const conflicts = snapshot.conflicts.map((conflict) => [
    conflict.name,
    conflict.selected.scope,
    ...conflict.shadowed.map(({ scope }) => scope),
  ]);
  const issues = [...diskIssues, ...overlayIssues]
    .map((issue) => [issue.code, issue.scope, issue.path, issue.message])
    .sort((left, right) => compareUnicodeCodePoints(String(left[2]), String(right[2])));
  return JSON.stringify({ entries, conflicts, issues });
}

async function publishBlob(root: string, digest: string, content: Uint8Array): Promise<void> {
  const directory = await prepareCacheDirectory(root, 'blobs');
  const target = join(directory, digest);
  try {
    const existing = await readCacheEntry(root, 'blobs', digest, content.byteLength);
    assertBytesDigest(existing, digest);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: 'wx' });
  try {
    assertBytesDigest(content, digest);
    try {
      await rename(temporary, target);
    } catch (error) {
      try {
        assertBytesDigest(await readCacheEntry(root, 'blobs', digest, content.byteLength), digest);
      } catch {
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function publishManifest(
  root: string,
  manifest: SkillRevisionManifest,
  limits: ResolvedBundleLimits,
): Promise<void> {
  const directory = await prepareCacheDirectory(root, 'manifests');
  validateManifest(manifest, limits);
  const serialized = canonicalJson(manifest);
  const target = join(directory, `${manifest.revisionRef.revisionId}.json`);
  try {
    const existing = parseCachedManifest(
      (await readCacheEntry(
        root,
        'manifests',
        `${manifest.revisionRef.revisionId}.json`,
        MAX_REVISION_MANIFEST_BYTES,
      )).toString('utf8'),
      limits,
    );
    if (canonicalJson(existing) !== serialized) {
      throw new Error('Skill revision manifest identity collision.');
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = join(
    directory,
    `.${manifest.revisionRef.revisionId}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
  try {
    try {
      await rename(temporary, target);
    } catch (error) {
      try {
        const existing = parseCachedManifest(
          (await readCacheEntry(
            root,
            'manifests',
            `${manifest.revisionRef.revisionId}.json`,
            MAX_REVISION_MANIFEST_BYTES,
          )).toString('utf8'),
          limits,
        );
        if (canonicalJson(existing) !== serialized) throw error;
      } catch {
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function captureBundle(
  canonicalRoot: string,
  limits: ResolvedBundleLimits,
): Promise<{
  entries: SkillResourceManifestEntry[];
  resources: ReadonlyMap<string, Buffer>;
}> {
  let lastChange: SkillBundleChangedError | undefined;
  for (let attempt = 1; attempt <= MAX_BUNDLE_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      return await captureBundleOnce(canonicalRoot, limits);
    } catch (error) {
      if (!(error instanceof SkillBundleChangedError)) throw error;
      lastChange = error;
    }
  }
  throw new SkillBundleChangedError(
    `Skill bundle did not stabilize after ${String(MAX_BUNDLE_CAPTURE_ATTEMPTS)} capture attempts: ${lastChange?.message ?? canonicalRoot}`,
  );
}

async function captureBundleOnce(
  canonicalRoot: string,
  limits: ResolvedBundleLimits,
): Promise<{
  entries: SkillResourceManifestEntry[];
  resources: ReadonlyMap<string, Buffer>;
}> {
  const entries: SkillResourceManifestEntry[] = [];
  const resources = new Map<string, Buffer>();
  const capturedFiles: CapturedFileState[] = [];
  const capturedDirectories: CapturedDirectoryState[] = [];
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const directoryBefore = await lstat(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error('Skill bundle directory must not be a symbolic link.');
    }
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    directoryEntries.sort((left, right) => compareUnicodeCodePoints(left.name, right.name));
    for (const entry of directoryEntries) {
      const path = join(directory, entry.name);
      const information = await lstat(path);
      if (information.isSymbolicLink()) {
        throw new Error(`Skill bundle contains a symbolic link: ${entry.name}.`);
      }
      if (information.isDirectory()) {
        const canonicalDirectory = await realpath(path);
        assertWithin(canonicalRoot, canonicalDirectory);
        await visit(canonicalDirectory);
        continue;
      }
      if (!information.isFile()) {
        throw new Error(`Skill bundle contains an unsupported filesystem entry: ${entry.name}.`);
      }
      if (entries.length >= limits.maxFiles) {
        throw new Error(`Skill bundle exceeds the ${String(limits.maxFiles)} resource file limit.`);
      }
      if (information.size > limits.maxFileBytes) {
        throw new Error(
          `Skill resource exceeds the ${String(limits.maxFileBytes)} byte per-file limit.`,
        );
      }
      totalBytes += information.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `Skill bundle exceeds the ${String(limits.maxTotalBytes)} byte total resource limit.`,
        );
      }
      const canonicalPath = await realpath(path);
      assertWithin(canonicalRoot, canonicalPath);
      const bytes = await readStableFile(canonicalPath, information, limits.maxFileBytes);
      const relativePath = toPortableResourcePath(relative(canonicalRoot, canonicalPath));
      const contentDigest = digestSkillBytes(bytes);
      const resourceEntry = { path: relativePath, contentDigest, byteSize: bytes.byteLength };
      entries.push(resourceEntry);
      resources.set(relativePath, bytes);
      capturedFiles.push({
        requestedPath: path,
        canonicalPath,
        information,
        entry: resourceEntry,
      });
    }
    const directoryAfter = await lstat(directory);
    const entriesAfter = await readdir(directory, { withFileTypes: true });
    if (
      !sameFileIdentity(directoryBefore, directoryAfter) ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryEntriesSignature(directoryEntries) !== directoryEntriesSignature(entriesAfter)
    ) {
      throw new SkillBundleChangedError(
        `Skill bundle changed while capturing directory: ${directory}.`,
      );
    }
    capturedDirectories.push({
      path: directory,
      information: directoryBefore,
      entriesSignature: directoryEntriesSignature(directoryEntries),
    });
  };

  await visit(canonicalRoot);
  await verifyCapturedBundle(
    canonicalRoot,
    capturedFiles,
    capturedDirectories,
    limits.maxFileBytes,
  );
  entries.sort((left, right) => compareResourcePaths(left.path, right.path));
  return { entries, resources };
}

async function verifyCapturedBundle(
  canonicalRoot: string,
  files: readonly CapturedFileState[],
  directories: readonly CapturedDirectoryState[],
  maxFileBytes: number,
): Promise<void> {
  for (const captured of files) {
    let requestedInformation: Awaited<ReturnType<typeof lstat>>;
    let canonicalPath: string;
    try {
      requestedInformation = await lstat(captured.requestedPath);
      if (requestedInformation.isSymbolicLink() || !requestedInformation.isFile()) {
        throw new SkillBundleChangedError(
          `Skill bundle changed before final resource verification: ${captured.requestedPath}.`,
        );
      }
      canonicalPath = await realpath(captured.requestedPath);
      assertWithin(canonicalRoot, canonicalPath);
    } catch (error) {
      if (error instanceof SkillBundleChangedError) throw error;
      throw new SkillBundleChangedError(
        `Skill bundle changed before final resource verification: ${captured.requestedPath}.`,
      );
    }
    if (!sameCanonicalPath(captured.canonicalPath, canonicalPath)) {
      throw new SkillBundleChangedError(
        `Skill bundle resource identity changed: ${captured.requestedPath}.`,
      );
    }
    const information = await lstat(canonicalPath);
    if (
      !sameFileIdentity(captured.information, information) ||
      captured.information.size !== information.size ||
      captured.information.mtimeMs !== information.mtimeMs
    ) {
      throw new SkillBundleChangedError(
        `Skill bundle resource changed before final verification: ${captured.requestedPath}.`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readStableFile(canonicalPath, information, maxFileBytes);
    } catch (error) {
      if (error instanceof SkillBundleChangedError) throw error;
      throw new SkillBundleChangedError(
        `Skill bundle resource changed during final verification: ${captured.requestedPath}.`,
      );
    }
    if (
      bytes.byteLength !== captured.entry.byteSize ||
      digestSkillBytes(bytes) !== captured.entry.contentDigest
    ) {
      throw new SkillBundleChangedError(
        `Skill bundle resource content changed: ${captured.requestedPath}.`,
      );
    }
  }

  for (const captured of directories) {
    let information: Awaited<ReturnType<typeof lstat>>;
    let canonicalPath: string;
    let entries;
    try {
      information = await lstat(captured.path);
      canonicalPath = await realpath(captured.path);
      assertWithin(canonicalRoot, canonicalPath);
      entries = await readdir(canonicalPath, { withFileTypes: true });
    } catch {
      throw new SkillBundleChangedError(
        `Skill bundle directory changed before final verification: ${captured.path}.`,
      );
    }
    if (
      information.isSymbolicLink() ||
      !information.isDirectory() ||
      !sameCanonicalPath(captured.path, canonicalPath) ||
      !sameFileIdentity(captured.information, information) ||
      captured.information.mtimeMs !== information.mtimeMs ||
      captured.entriesSignature !== directoryEntriesSignature(entries)
    ) {
      throw new SkillBundleChangedError(
        `Skill bundle directory changed before final verification: ${captured.path}.`,
      );
    }
  }
}

async function readStableFile(
  path: string,
  before: Awaited<ReturnType<typeof lstat>>,
  maxBytes?: number,
): Promise<Buffer> {
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Skill resource must be a real file: ${path}.`);
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFileIdentity(before, opened) ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    ) {
      throw new SkillBundleChangedError(
        `Skill bundle changed before capturing resource: ${path}.`,
      );
    }
    if (maxBytes !== undefined && opened.size > maxBytes) throw resourceReadTooLarge(maxBytes);
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterPath = await lstat(path);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(opened, afterRead) ||
      !sameFileIdentity(opened, afterPath) ||
      opened.size !== afterRead.size ||
      opened.mtimeMs !== afterRead.mtimeMs ||
      opened.size !== afterPath.size ||
      opened.mtimeMs !== afterPath.mtimeMs ||
      bytes.byteLength !== opened.size
    ) {
      throw new SkillBundleChangedError(`Skill bundle changed while capturing resource: ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryEntriesSignature(
  entries: readonly { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[],
): string {
  return entries
    .map((entry) => [entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()])
    .sort((left, right) => compareUnicodeCodePoints(String(left[0]), String(right[0])))
    .map((entry) => entry.join(':'))
    .join('\0');
}

function createRevisionManifest(
  descriptor: SkillDescriptor,
  resources: readonly SkillResourceManifestEntry[],
): SkillRevisionManifest {
  const frozenResources = resources.map((entry) => Object.freeze({ ...entry }));
  const bundleDigest = digestSkillContent(canonicalJson(frozenResources));
  const identity = {
    schemaVersion: 1 as const,
    scope: descriptor.scope,
    sourceId: descriptor.sourceId,
    sourcePath: descriptor.sourcePath,
    bundleRoot: descriptor.bundleRoot,
    sourceOrder: descriptor.sourceOrder,
    name: descriptor.name,
    contentDigest: descriptor.contentDigest,
    bundleDigest,
  };
  const revisionRef = Object.freeze({
    ...identity,
    revisionId: digestSkillContent(canonicalJson(identity)),
  });
  return Object.freeze({
    schemaVersion: 1,
    revisionRef,
    resources: Object.freeze(frozenResources),
  });
}

function overlayRevisionManifest(
  descriptor: SkillDescriptor,
  content: string,
): SkillRevisionManifest {
  return createRevisionManifest(descriptor, [
    {
      path: 'SKILL.md',
      contentDigest: descriptor.contentDigest,
      byteSize: Buffer.byteLength(content, 'utf8'),
    },
  ]);
}

function descriptorWithManifest(
  descriptor: SkillDescriptor,
  manifest: SkillRevisionManifest,
): SkillDescriptor {
  return { ...descriptor, revisionRef: Object.freeze({ ...manifest.revisionRef }) };
}

function parseCachedManifest(
  serialized: string,
  limits: ResolvedBundleLimits,
): SkillRevisionManifest {
  const value: unknown = JSON.parse(serialized);
  validateManifest(value, limits);
  return value;
}

function validateManifest(
  value: unknown,
  limits: ResolvedBundleLimits,
): asserts value is SkillRevisionManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'revisionRef', 'resources']) ||
    !Array.isArray(value.resources)
  ) {
    throw new Error('Skill revision cache manifest is invalid.');
  }
  const manifest = value as Readonly<{
    schemaVersion: unknown;
    revisionRef: unknown;
    resources: readonly unknown[];
  }>;
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported Skill revision manifest version.');
  validateRevisionRef(manifest.revisionRef);
  if (manifest.resources.length > limits.maxFiles) {
    throw new Error(`Skill bundle exceeds the ${String(limits.maxFiles)} resource file limit.`);
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const entry of manifest.resources) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'contentDigest', 'byteSize']) ||
      typeof entry.path !== 'string' ||
      typeof entry.contentDigest !== 'string' ||
      typeof entry.byteSize !== 'number'
    ) {
      throw new Error('Skill revision cache manifest resource is invalid.');
    }
    const normalizedPath = normalizeResourcePath(entry.path);
    if (normalizedPath !== entry.path || seen.has(entry.path)) {
      throw new Error('Skill revision manifest resource path is invalid.');
    }
    if (!/^[a-f0-9]{64}$/.test(entry.contentDigest)) {
      throw new Error('Skill revision manifest resource digest is invalid.');
    }
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
      throw new Error('Skill revision manifest resource size is invalid.');
    }
    if (entry.byteSize > limits.maxFileBytes) {
      throw new Error(
        `Skill resource exceeds the ${String(limits.maxFileBytes)} byte per-file limit.`,
      );
    }
    totalBytes += entry.byteSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `Skill bundle exceeds the ${String(limits.maxTotalBytes)} byte total resource limit.`,
      );
    }
    seen.add(entry.path);
  }
  const resources = manifest.resources as readonly SkillResourceManifestEntry[];
  if (
    resources.some(
      (entry, index) =>
        index > 0 && compareResourcePaths(resources[index - 1]!.path, entry.path) >= 0,
    )
  ) {
    throw new Error('Skill revision manifest resources must be uniquely sorted by path.');
  }
  const bundleDigest = digestSkillContent(canonicalJson(resources));
  if (bundleDigest !== manifest.revisionRef.bundleDigest) {
    throw new Error('Skill revision manifest bundle digest mismatch.');
  }
  const identity = revisionIdentity(manifest.revisionRef);
  if (digestSkillContent(canonicalJson(identity)) !== manifest.revisionRef.revisionId) {
    throw new Error('Skill revision manifest identity mismatch.');
  }
  const document = resources.find(({ path }) => path === 'SKILL.md');
  if (!document || document.contentDigest !== manifest.revisionRef.contentDigest) {
    throw new Error('Skill revision manifest does not bind SKILL.md.');
  }
}

function revisionRefsEqual(left: SkillRevisionRef, right: SkillRevisionRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareResourcePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeResourcePath(path: string): string {
  if (!path.trim() || isAbsolute(path)) {
    throw new Error('Skill resource path must be a non-empty relative path.');
  }
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Skill resource path escapes its Skill directory.');
  }
  return normalized;
}

function toPortableResourcePath(path: string): string {
  return normalizeResourcePath(path.replace(/\\/gu, '/'));
}

function validateResourceReadLimit(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_RESOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Skill resource maxBytes must be a positive integer.');
  }
  return maxBytes;
}

function resourceReadTooLarge(maxBytes: number): Error {
  return new Error(`Skill resource exceeds the ${String(maxBytes)} byte limit.`);
}

function resolveBundleLimits(input: SkillBundleLimits = {}): ResolvedBundleLimits {
  const limits = {
    maxFiles: input.maxFiles ?? DEFAULT_BUNDLE_FILES,
    maxFileBytes: input.maxFileBytes ?? DEFAULT_RESOURCE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? DEFAULT_BUNDLE_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Skill bundle ${name} must be a positive integer.`);
    }
  }
  return limits;
}

function assertBundleByteLimits(byteSize: number, limits: ResolvedBundleLimits): void {
  if (byteSize > limits.maxFileBytes) {
    throw new Error(
      `Skill resource exceeds the ${String(limits.maxFileBytes)} byte per-file limit.`,
    );
  }
  if (byteSize > limits.maxTotalBytes) {
    throw new Error(
      `Skill bundle exceeds the ${String(limits.maxTotalBytes)} byte total resource limit.`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot canonicalize an undefined value.');
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revisionContext(revisionRef: SkillRevisionRef) {
  return {
    scope: revisionRef.scope,
    sourceId: revisionRef.sourceId,
    sourcePath: revisionRef.sourcePath,
    bundleRoot: revisionRef.bundleRoot,
    sourceOrder: revisionRef.sourceOrder,
    expectedName: revisionRef.name,
    contentDigest: revisionRef.contentDigest,
    revisionRef,
  };
}

function validateRevisionRef(value: unknown): asserts value is SkillRevisionRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'revisionId',
      'scope',
      'sourceId',
      'sourcePath',
      'bundleRoot',
      'sourceOrder',
      'name',
      'contentDigest',
      'bundleDigest',
    ])
  ) {
    throw new Error('Skill revision reference is incomplete.');
  }
  const revisionRef = value;
  if (revisionRef.schemaVersion !== 1) throw new Error('Unsupported Skill revision schema version.');
  if (
    typeof revisionRef.scope !== 'string' ||
    !(SKILL_SCOPES as readonly string[]).includes(revisionRef.scope)
  ) {
    throw new Error('Skill revision scope is invalid.');
  }
  if (
    typeof revisionRef.contentDigest !== 'string' ||
    typeof revisionRef.bundleDigest !== 'string' ||
    typeof revisionRef.revisionId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(revisionRef.contentDigest) ||
    !/^[a-f0-9]{64}$/.test(revisionRef.bundleDigest) ||
    !/^[a-f0-9]{64}$/.test(revisionRef.revisionId)
  ) {
    throw new Error('Skill revision content digest is invalid.');
  }
  if (
    typeof revisionRef.sourceId !== 'string' ||
    !revisionRef.sourceId ||
    typeof revisionRef.sourcePath !== 'string' ||
    !revisionRef.sourcePath ||
    typeof revisionRef.bundleRoot !== 'string' ||
    !revisionRef.bundleRoot ||
    typeof revisionRef.name !== 'string' ||
    !revisionRef.name ||
    typeof revisionRef.sourceOrder !== 'number' ||
    !Number.isSafeInteger(revisionRef.sourceOrder) ||
    revisionRef.sourceOrder < 0
  ) {
    throw new Error('Skill revision reference is incomplete.');
  }
  const identity = revisionIdentity(revisionRef as SkillRevisionRef);
  if (digestSkillContent(canonicalJson(identity)) !== revisionRef.revisionId) {
    throw new Error('Skill revision digest/identity mismatch.');
  }
}

function captureRevisionRef(value: unknown): SkillRevisionRef {
  validateRevisionRef(value);
  return Object.freeze({ ...value });
}

function revisionIdentity(revisionRef: SkillRevisionRef): Omit<SkillRevisionRef, 'revisionId'> {
  return {
    schemaVersion: revisionRef.schemaVersion,
    scope: revisionRef.scope,
    sourceId: revisionRef.sourceId,
    sourcePath: revisionRef.sourcePath,
    bundleRoot: revisionRef.bundleRoot,
    sourceOrder: revisionRef.sourceOrder,
    name: revisionRef.name,
    contentDigest: revisionRef.contentDigest,
    bundleDigest: revisionRef.bundleDigest,
  };
}

function digestSkillContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function digestSkillBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeUtf8Document(content: Uint8Array): string {
  return decodeUtf8Resource(content);
}

function decodeUtf8Resource(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch (error) {
    throw new Error('Skill text resource must contain valid UTF-8.', { cause: error });
  }
}

function assertBytesDigest(content: Uint8Array, expected: string): void {
  if (digestSkillBytes(content) !== expected) throw new Error('Skill revision blob digest mismatch.');
}


function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function prepareCacheDirectory(root: string, name: 'blobs' | 'manifests'): Promise<string> {
  await mkdir(root, { recursive: true });
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new Error('Skill revision cache root must be a real directory, not a symbolic link.');
  }
  const canonicalRoot = await realpath(root);
  const requested = join(canonicalRoot, name);
  await mkdir(requested, { recursive: true });
  return await validateCacheDirectory(canonicalRoot, requested);
}

async function readCacheEntry(
  root: string,
  directoryName: 'blobs' | 'manifests',
  fileName: string,
  maxBytes: number,
): Promise<Buffer> {
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new Error('Skill revision cache root must be a real directory, not a symbolic link.');
  }
  const canonicalRoot = await realpath(root);
  const directory = await validateCacheDirectory(canonicalRoot, join(canonicalRoot, directoryName));
  const requested = join(directory, fileName);
  const information = await lstat(requested);
  if (information.isSymbolicLink()) {
    throw new Error('Skill revision cache entry must not be a symbolic link.');
  }
  const target = await realpath(requested);
  assertWithin(directory, target);
  if (!information.isFile()) throw new Error('Skill revision cache entry must be a file.');
  return await readStableFile(target, information, maxBytes);
}

async function validateCacheDirectory(canonicalRoot: string, requested: string): Promise<string> {
  const information = await lstat(requested);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error('Skill revision cache directory must not be a symbolic link.');
  }
  const directory = await realpath(requested);
  assertWithin(canonicalRoot, directory);
  return directory;
}

async function assertPathSegmentsAreRealDirectories(
  root: string,
  relativePath: string,
): Promise<void> {
  let current = root;
  const segments = relativePath.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const information = await lstat(current);
    if (information.isSymbolicLink()) {
      throw new Error('Skill resource parent directory must not be a symbolic link.');
    }
    if (!information.isDirectory()) {
      throw new Error('Skill resource parent path must be a directory.');
    }
  }
}


function scopeKey(scope: SkillScope, name: string): string {
  return `${scope}\0${name}`;
}

function classifyIssue(error: unknown): SkillIssueCode {
  const message = errorMessage(error);
  const errorCode = (error as NodeJS.ErrnoException).code;
  if (
    errorCode &&
    ['EACCES', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EPERM'].includes(errorCode)
  ) {
    return 'read-failed';
  }
  if (message.includes('frontmatter exceeds')) return 'frontmatter-too-large';
  if (
    message.includes('Skill resource exceeds') ||
    message.includes('total resource limit') ||
    message.includes('resource file limit')
  ) {
    return 'file-too-large';
  }
  if (message.includes('exceeds the') && message.includes('SKILL.md')) return 'file-too-large';
  if (message.includes('must match its parent directory')) {
    return 'name-directory-mismatch';
  }
  if (message.includes('Skill "name"')) return 'invalid-name';
  if (message.includes('frontmatter') || message.includes('metadata')) {
    return 'invalid-frontmatter';
  }
  return 'invalid-document';
}

function assertWithin(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Skill resource path escapes its Skill directory.');
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
