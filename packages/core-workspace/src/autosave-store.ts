import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type WorkspaceAutosaveKind = 'sql' | 'python' | 'markdown' | 'text';

export type WorkspaceAutosaveDraftInput = {
  draftId: string;
  kind: WorkspaceAutosaveKind;
  content: string;
  title?: string;
  workspaceRootPath?: string;
  relativePath?: string;
  connectionId?: string;
  language?: string;
};

export type WorkspaceAutosaveDraft = WorkspaceAutosaveDraftInput & {
  version: 1;
  savedAt: string;
  bytes: number;
  contentHash: string;
};

export type WorkspaceAutosaveSummary = Omit<WorkspaceAutosaveDraft, 'content'> & {
  preview: string;
};

export type WorkspaceAutosaveListOptions = {
  kind?: WorkspaceAutosaveKind;
  workspaceRootPath?: string;
};

export type WorkspaceAutosaveStoreOptions = {
  delayMs?: number;
  now?: () => Date;
};

type PendingAutosave = {
  timer: ReturnType<typeof setTimeout>;
  draft: WorkspaceAutosaveDraftInput;
};

export class WorkspaceAutosaveStore {
  private readonly pending = new Map<string, PendingAutosave>();
  private readonly delayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly autosaveRootPath: string,
    options: WorkspaceAutosaveStoreOptions = {},
  ) {
    this.delayMs = Math.max(0, Math.floor(options.delayMs ?? 2000));
    this.now = options.now ?? (() => new Date());
  }

  schedule(input: WorkspaceAutosaveDraftInput, delayMs = this.delayMs): void {
    const draft = normalizeInput(input);
    this.cancelPending(draft.draftId);
    const timer = setTimeout(() => {
      void this.saveNow(draft);
    }, Math.max(0, Math.floor(delayMs)));
    this.pending.set(draft.draftId, { timer, draft });
  }

  async saveNow(input: WorkspaceAutosaveDraftInput): Promise<WorkspaceAutosaveDraft> {
    const draft = normalizeInput(input);
    this.cancelPending(draft.draftId);
    const saved = toSavedDraft(draft, this.now());
    await atomicWriteJson(this.pathForDraftId(saved.draftId), saved);
    return saved;
  }

  async flush(draftId: string): Promise<WorkspaceAutosaveDraft | undefined> {
    const pending = this.pending.get(draftId);
    if (!pending) return undefined;
    return this.saveNow(pending.draft);
  }

  async flushAll(): Promise<WorkspaceAutosaveDraft[]> {
    const pending = [...this.pending.values()];
    const drafts = pending.map((item) => item.draft);
    for (const item of pending) clearTimeout(item.timer);
    this.pending.clear();
    return Promise.all(drafts.map((draft) => this.saveNow(draft)));
  }

  async read(draftId: string): Promise<WorkspaceAutosaveDraft | undefined> {
    return readDraftFile(this.pathForDraftId(draftId));
  }

  async list(options: WorkspaceAutosaveListOptions = {}): Promise<WorkspaceAutosaveSummary[]> {
    const drafts = await this.readAll();
    return drafts
      .filter((draft) => (options.kind ? draft.kind === options.kind : true))
      .filter((draft) => (options.workspaceRootPath ? draft.workspaceRootPath === options.workspaceRootPath : true))
      .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt) || right.draftId.localeCompare(left.draftId))
      .map(toSummary);
  }

  async remove(draftId: string): Promise<boolean> {
    this.cancelPending(draftId);
    const path = this.pathForDraftId(draftId);
    try {
      await stat(path);
      await rm(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  pendingDraftIds(): string[] {
    return [...this.pending.keys()].sort();
  }

  private cancelPending(draftId: string): void {
    const pending = this.pending.get(draftId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(draftId);
  }

  private async readAll(): Promise<WorkspaceAutosaveDraft[]> {
    try {
      const entries = await readdir(this.autosaveRootPath, { withFileTypes: true });
      const drafts = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => readDraftFile(join(this.autosaveRootPath, entry.name))),
      );
      return drafts.filter((draft): draft is WorkspaceAutosaveDraft => Boolean(draft));
    } catch {
      return [];
    }
  }

  private pathForDraftId(draftId: string): string {
    return join(this.autosaveRootPath, `${hashDraftId(draftId)}.json`);
  }
}

function normalizeInput(input: WorkspaceAutosaveDraftInput): WorkspaceAutosaveDraftInput {
  const draftId = input.draftId.trim();
  if (!draftId) throw new Error('Autosave draft id is required.');
  if (!isAutosaveKind(input.kind)) throw new Error('Autosave draft kind is invalid.');
  return {
    draftId,
    kind: input.kind,
    content: input.content ?? '',
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.workspaceRootPath?.trim() ? { workspaceRootPath: input.workspaceRootPath.trim() } : {}),
    ...(input.relativePath?.trim() ? { relativePath: input.relativePath.trim() } : {}),
    ...(input.connectionId?.trim() ? { connectionId: input.connectionId.trim() } : {}),
    ...(input.language?.trim() ? { language: input.language.trim() } : {}),
  };
}

function toSavedDraft(input: WorkspaceAutosaveDraftInput, now: Date): WorkspaceAutosaveDraft {
  return {
    version: 1,
    ...input,
    savedAt: now.toISOString(),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    contentHash: createHash('sha256').update(input.content).digest('hex'),
  };
}

async function readDraftFile(path: string): Promise<WorkspaceAutosaveDraft | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    return normalizeDraft(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function normalizeDraft(input: unknown): WorkspaceAutosaveDraft | undefined {
  if (!isRecord(input) || input.version !== 1) return undefined;
  if (typeof input.draftId !== 'string' || typeof input.content !== 'string') return undefined;
  if (!isAutosaveKind(input.kind)) return undefined;
  if (typeof input.savedAt !== 'string' || typeof input.contentHash !== 'string') return undefined;
  const draft: WorkspaceAutosaveDraft = {
    version: 1,
    draftId: input.draftId,
    kind: input.kind,
    content: input.content,
    savedAt: input.savedAt,
    bytes: typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? input.bytes : Buffer.byteLength(input.content, 'utf8'),
    contentHash: input.contentHash,
  };
  if (typeof input.title === 'string') draft.title = input.title;
  if (typeof input.workspaceRootPath === 'string') draft.workspaceRootPath = input.workspaceRootPath;
  if (typeof input.relativePath === 'string') draft.relativePath = input.relativePath;
  if (typeof input.connectionId === 'string') draft.connectionId = input.connectionId;
  if (typeof input.language === 'string') draft.language = input.language;
  return draft;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

function toSummary(draft: WorkspaceAutosaveDraft): WorkspaceAutosaveSummary {
  const { content, ...summary } = draft;
  return {
    ...summary,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

function hashDraftId(draftId: string): string {
  return createHash('sha256').update(draftId).digest('hex').slice(0, 32);
}

function isAutosaveKind(value: unknown): value is WorkspaceAutosaveKind {
  return value === 'sql' || value === 'python' || value === 'markdown' || value === 'text';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
