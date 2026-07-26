import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSkillDocument, parseSkillMetadata } from './skill-parser.js';
import { parseSkillInvocation } from './skill-invocation.js';
import { searchSkillCatalog } from './skill-search.js';
import type {
  ActivatedSkillInvocation,
  SkillCatalogEntry,
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
  SkillRegistryOptions,
  SkillSearchOptions,
  SkillSearchResult,
  SkillScope,
  SkillWatcher,
  SkillWatchOptions,
} from './types.js';

const MAX_FRONTMATTER_BYTES = 64 * 1_024;
const MAX_SKILL_DOCUMENT_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_RESOURCE_BYTES = 2 * 1_024 * 1_024;
const SCOPE_RANK: Readonly<Record<SkillScope, number>> = {
  system: 0,
  user: 1,
  project: 2,
  session: 3,
};

type DiskOrigin = {
  kind: 'disk';
  documentPath: string;
};

type OverlayOrigin = {
  kind: 'overlay';
  content: string;
};

type SkillCandidate = {
  descriptor: SkillDescriptor;
  origin: DiskOrigin | OverlayOrigin;
};

type RegistrySnapshot = {
  selected: Map<string, SkillCandidate>;
  selectedByScope: Map<string, SkillCandidate>;
  conflicts: SkillConflict[];
};

export class SkillRegistry {
  private sources: SkillDirectorySource[];
  private diskCandidates: SkillCandidate[] = [];
  private overlayCandidates: SkillCandidate[] = [];
  private diskIssues: SkillLoadIssue[] = [];
  private overlayIssues: SkillLoadIssue[] = [];
  private snapshot: RegistrySnapshot = emptySnapshot();
  private revision = 0;
  private signature = '';
  private refreshInFlight: Promise<SkillRefreshResult> | undefined;
  private fileWatchers = new Map<string, FSWatcher>();
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchPoller: ReturnType<typeof setInterval> | undefined;
  private watchOptions: SkillWatchOptions | undefined;

  constructor(options: SkillRegistryOptions = {}) {
    this.sources = cloneSources(options.sources ?? []);
    if (options.sessionOverlay) this.replaceSessionOverlay(options.sessionOverlay);
  }

  setSources(sources: readonly SkillDirectorySource[]): void {
    this.sources = cloneSources(sources);
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
    const view = new SkillRegistry({ sources: this.sources });
    view.diskCandidates = this.diskCandidates;
    view.diskIssues = this.diskIssues;
    view.replaceSessionOverlay(overlays);
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
        candidates.push({
          descriptor,
          origin: { kind: 'overlay', content: overlay.content },
        });
      } catch (error) {
        issues.push({
          code: classifyIssue(error),
          scope: 'session',
          path: provisionalPath,
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
    return values.map(({ descriptor }) => toCatalogEntry(descriptor)).sort(compareCatalogEntries);
  }

  /**
   * Returns the Tier-1 catalog intended for model context. It deliberately
   * omits paths, hashes, metadata and Skill instructions.
   */
  catalogForModel(): SkillCatalogEntry[] {
    return this.list();
  }

  get(lookup: string | SkillLookup): SkillCatalogEntry | undefined {
    const candidate = this.findCandidate(normalizeLookup(lookup));
    return candidate ? toCatalogEntry(candidate.descriptor) : undefined;
  }

  inspect(lookup: string | SkillLookup): SkillDescriptor | undefined {
    const candidate = this.findCandidate(normalizeLookup(lookup));
    return candidate ? cloneDescriptor(candidate.descriptor) : undefined;
  }

  async load(lookup: string | SkillLookup): Promise<SkillDocument> {
    const normalized = normalizeLookup(lookup);
    const candidate = this.findCandidate(normalized);
    if (!candidate) {
      const scope = normalized.scope ? ` in ${normalized.scope} scope` : '';
      throw new Error(`Skill "${normalized.name}" was not found${scope}.`);
    }

    const content =
      candidate.origin.kind === 'overlay'
        ? candidate.origin.content
        : await readSkillFile(candidate.origin.documentPath);
    return parseSkillDocument(content, descriptorContext(candidate.descriptor));
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
    const discovered = await Promise.all(
      this.sources.map((source, sourceOrder) => discoverSource(source, sourceOrder)),
    );
    this.diskCandidates = discovered.flatMap((result) => result.candidates);
    this.diskIssues = discovered.flatMap((result) => result.issues);
    return this.rebuildSnapshot();
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

export async function readSkillTextResource(
  skill: SkillDescriptor,
  relativePath: string,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_RESOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Skill resource maxBytes must be a positive integer.');
  }
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    throw new Error('Skill resource path must be a non-empty relative path.');
  }

  const root = await realpath(skill.bundleRoot);
  const requested = resolve(root, relativePath);
  assertWithin(root, requested);
  const target = await realpath(requested);
  assertWithin(root, target);
  const information = await stat(target);
  if (!information.isFile()) throw new Error('Skill resource path must refer to a file.');
  if (information.size > maxBytes) {
    throw new Error(`Skill resource exceeds the ${String(maxBytes)} byte limit.`);
  }
  return await readFile(target, 'utf8');
}

async function discoverSource(
  source: SkillDirectorySource,
  sourceOrder: number,
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
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          bundleRoot: join(source.path, entry.name),
          documentPath: join(source.path, entry.name, 'SKILL.md'),
          expectedName: entry.name,
        }));

  const candidates: SkillCandidate[] = [];
  const issues: SkillLoadIssue[] = [];
  for (const candidatePath of paths) {
    try {
      const information = await stat(candidatePath.documentPath);
      if (!information.isFile()) continue;
      const content = await readFrontmatterPrefix(candidatePath.documentPath);
      const descriptor = parseSkillMetadata(content, {
        scope: source.scope,
        sourceId,
        sourcePath: candidatePath.documentPath,
        bundleRoot: candidatePath.bundleRoot,
        sourceOrder,
        expectedName: candidatePath.expectedName,
        modifiedAtMs: information.mtimeMs,
      });
      candidates.push({
        descriptor,
        origin: { kind: 'disk', documentPath: candidatePath.documentPath },
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

async function readFrontmatterPrefix(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    if (!hasClosingFrontmatterDelimiter(content)) {
      if (bytesRead === MAX_FRONTMATTER_BYTES) {
        throw new Error(
          `SKILL.md frontmatter exceeds the ${String(MAX_FRONTMATTER_BYTES)} byte limit.`,
        );
      }
      throw new Error('SKILL.md YAML frontmatter is missing its closing "---" delimiter.');
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readSkillFile(path: string): Promise<string> {
  const information = await stat(path);
  if (information.size > MAX_SKILL_DOCUMENT_BYTES) {
    throw new Error(`SKILL.md exceeds the ${String(MAX_SKILL_DOCUMENT_BYTES)} byte limit.`);
  }
  return await readFile(path, 'utf8');
}

function hasClosingFrontmatterDelimiter(content: string): boolean {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return /^---\n[\s\S]*?\n---(?:[ \t]*\n|[ \t]*$)/.test(normalized);
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
  conflicts.sort((left, right) => left.name.localeCompare(right.name));
  return { selected, selectedByScope, conflicts };
}

function compareCandidates(left: SkillCandidate, right: SkillCandidate): number {
  const scope = SCOPE_RANK[right.descriptor.scope] - SCOPE_RANK[left.descriptor.scope];
  if (scope !== 0) return scope;
  const source = right.descriptor.sourceOrder - left.descriptor.sourceOrder;
  if (source !== 0) return source;
  return right.descriptor.sourcePath.localeCompare(left.descriptor.sourcePath);
}

function compareCatalogEntries(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
  return left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope);
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
    preapprovedTools: [...descriptor.preapprovedTools],
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
    ])
    .sort(
      (left, right) =>
        String(left[0]).localeCompare(String(right[0])) ||
        String(left[3]).localeCompare(String(right[3])) ||
        String(left[4]).localeCompare(String(right[4])),
    );
  const conflicts = snapshot.conflicts.map((conflict) => [
    conflict.name,
    conflict.selected.scope,
    ...conflict.shadowed.map(({ scope }) => scope),
  ]);
  const issues = [...diskIssues, ...overlayIssues]
    .map((issue) => [issue.code, issue.scope, issue.path, issue.message])
    .sort((left, right) => String(left[2]).localeCompare(String(right[2])));
  return JSON.stringify({ entries, conflicts, issues });
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
