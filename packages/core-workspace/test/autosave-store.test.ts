import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAutosaveStore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceAutosaveStore', () => {
  it('debounces SQL draft writes so recovery keeps the latest editor content', async () => {
    vi.useFakeTimers();
    const store = new WorkspaceAutosaveStore(await autosavePath(), {
      delayMs: 100,
      now: () => new Date('2026-06-24T01:00:00.000Z'),
    });

    store.schedule({
      draftId: 'tab-orders',
      kind: 'sql',
      title: '订单分析',
      workspaceRootPath: 'C:/work/ecommerce',
      relativePath: 'queries/orders.sql',
      connectionId: 'prod_pg',
      content: 'select * from orders;',
    });
    store.schedule({
      draftId: 'tab-orders',
      kind: 'sql',
      title: '订单分析',
      workspaceRootPath: 'C:/work/ecommerce',
      relativePath: 'queries/orders.sql',
      connectionId: 'prod_pg',
      content: 'select id, total_amount from orders limit 100;',
    });

    expect(store.pendingDraftIds()).toEqual(['tab-orders']);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(async () => {
      await expect(store.read('tab-orders')).resolves.toBeDefined();
    });

    const recovered = await store.read('tab-orders');
    expect(recovered).toMatchObject({
      draftId: 'tab-orders',
      kind: 'sql',
      title: '订单分析',
      workspaceRootPath: 'C:/work/ecommerce',
      relativePath: 'queries/orders.sql',
      connectionId: 'prod_pg',
      content: 'select id, total_amount from orders limit 100;',
      bytes: 46,
      savedAt: '2026-06-24T01:00:00.000Z',
    });
    expect(recovered?.contentHash).toHaveLength(64);
    expect(store.pendingDraftIds()).toEqual([]);
  });

  it('flushes pending SQL and Python drafts before application quit', async () => {
    vi.useFakeTimers();
    let tick = 0;
    const store = new WorkspaceAutosaveStore(await autosavePath(), {
      delayMs: 5000,
      now: () => new Date(`2026-06-24T01:00:0${tick++}.000Z`),
    });

    store.schedule({ draftId: 'sql-tab', kind: 'sql', content: 'select 1;' });
    store.schedule({ draftId: 'python-tab', kind: 'python', content: 'print("etl")\n' });

    const flushed = await store.flushAll();

    expect(flushed.map((draft) => draft.draftId).sort()).toEqual(['python-tab', 'sql-tab']);
    expect(store.pendingDraftIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(store.read('sql-tab')).resolves.toMatchObject({ content: 'select 1;' });
    await expect(store.read('python-tab')).resolves.toMatchObject({ content: 'print("etl")\n' });
  });

  it('lists recoverable drafts newest-first and filters by kind or workspace', async () => {
    let now = new Date('2026-06-24T01:00:00.000Z');
    const store = new WorkspaceAutosaveStore(await autosavePath(), { now: () => now });

    await store.saveNow({ draftId: 'old-sql', kind: 'sql', workspaceRootPath: 'C:/work/a', content: 'select 1;' });
    now = new Date('2026-06-24T01:05:00.000Z');
    await store.saveNow({
      draftId: 'new-python',
      kind: 'python',
      workspaceRootPath: 'C:/work/b',
      content: 'import pandas as pd\nprint(pd.__version__)\n',
    });

    await expect(store.list()).resolves.toMatchObject([
      { draftId: 'new-python', kind: 'python', preview: 'import pandas as pd print(pd.__version__)' },
      { draftId: 'old-sql', kind: 'sql', preview: 'select 1;' },
    ]);
    await expect(store.list({ kind: 'sql' })).resolves.toMatchObject([{ draftId: 'old-sql' }]);
    await expect(store.list({ workspaceRootPath: 'C:/work/b' })).resolves.toMatchObject([{ draftId: 'new-python' }]);
  });

  it('ignores corrupt autosave files so startup recovery can continue', async () => {
    const root = await autosavePath();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'broken.json'), '{not valid json', 'utf8');
    const store = new WorkspaceAutosaveStore(root);
    await store.saveNow({ draftId: 'good', kind: 'sql', content: 'select 1;' });

    await expect(store.list()).resolves.toMatchObject([{ draftId: 'good' }]);
  });

  it('removes a recovered draft after the user accepts or discards it', async () => {
    const store = new WorkspaceAutosaveStore(await autosavePath());
    await store.saveNow({ draftId: 'tab-to-clear', kind: 'markdown', content: '# report\n' });

    await expect(store.remove('tab-to-clear')).resolves.toBe(true);
    await expect(store.read('tab-to-clear')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });
});

async function autosavePath(): Promise<string> {
  const root = join(await tempDir(), 'autosave');
  return root;
}

async function tempDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-autosave-'));
  tempDirs.push(dir);
  return dir;
}
