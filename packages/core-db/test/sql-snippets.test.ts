import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinSqlSnippets, expandSqlSnippet, SqlSnippetStore } from '../src/sql-snippets.js';

const tempDirs: string[] = [];

async function snippetPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-snippets-'));
  tempDirs.push(dir);
  return join(dir, 'snippets', 'sql-snippets.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqlSnippetStore', () => {
  it('provides the required built-in SQL snippets', async () => {
    const store = new SqlSnippetStore(await snippetPath());

    const snippets = await store.list({ includeUser: false });

    expect(snippets.map((snippet) => snippet.trigger)).toEqual([
      'cre-idx',
      'cre-table',
      'del',
      'ins',
      'sel',
      'upd',
    ]);
    expect(snippets.every((snippet) => snippet.source === 'builtin')).toBe(true);
  });

  it('expands a built-in select snippet with user values and defaults', () => {
    const snippet = builtinSqlSnippets.find((item) => item.trigger === 'sel');
    expect(snippet).toBeDefined();

    const expanded = expandSqlSnippet(snippet!, {
      table: 'orders',
      limit: 50,
    });

    expect(expanded.sql).toBe(['select *', 'from public.orders', 'limit 50;'].join('\n'));
    expect(expanded.missingVariables).toEqual([]);
    expect(expanded.warnings.join(' ')).toContain('normal execution review');
  });

  it('creates a user snippet and persists it across store instances', async () => {
    const filePath = await snippetPath();
    const store = new SqlSnippetStore(filePath);

    const created = await store.create({
      trigger: 'top-buyers',
      title: 'Top buyers',
      description: 'Revenue ranking for the latest analysis window.',
      body: `
        select user_id, sum(total_amount) as revenue
        from orders
        where created_at >= {{since}}
        group by user_id
        order by revenue desc
        limit {{limit}};
      `,
      variables: [
        { name: 'since', defaultValue: "current_date - interval '30 days'" },
        { name: 'limit', defaultValue: '100' },
      ],
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reloaded = new SqlSnippetStore(filePath);
    await expect(reloaded.resolve('top-buyers')).resolves.toMatchObject({
      id: created.data.id,
      trigger: 'top-buyers',
      title: 'Top buyers',
      source: 'user',
    });
  });

  it('rejects invalid triggers and built-in trigger overrides', async () => {
    const store = new SqlSnippetStore(await snippetPath());

    await expect(
      store.create({
        trigger: 'SELECT *',
        title: 'Bad trigger',
        body: 'select 1;',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });

    await expect(
      store.create({
        trigger: 'sel',
        title: 'Override built-in select',
        body: 'select 2;',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Built-in SQL snippet trigger cannot be overwritten: sel.',
      },
    });
  });

  it('updates, searches, and removes user snippets without changing built-ins', async () => {
    const store = new SqlSnippetStore(await snippetPath());
    const created = await store.create({
      trigger: 'rev-by-city',
      title: 'Revenue by city',
      body: 'select city, sum(total_amount) from orders group by city;',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await store.update(created.data.id, {
      title: 'Revenue by city and month',
      body: "select date_trunc('month', created_at), city, sum(total_amount) from orders group by 1, 2;",
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.updatedAt).not.toBe(created.data.updatedAt);

    await expect(store.list({ query: 'month', includeBuiltins: false })).resolves.toHaveLength(1);
    await expect(store.remove(created.data.id)).resolves.toBe(true);
    await expect(store.resolve('rev-by-city')).resolves.toBeUndefined();
    expect(
      (await store.list({ includeUser: false })).some((snippet) => snippet.trigger === 'sel'),
    ).toBe(true);
  });

  it('reports missing variables while still producing an expandable SQL draft', () => {
    const expanded = expandSqlSnippet(
      {
        id: 'user:example',
        trigger: 'custom',
        title: 'Custom',
        source: 'user',
        body: 'select * from {{schema}}.{{table}} where {{condition}};',
        variables: [{ name: 'schema', defaultValue: 'public' }],
      },
      { table: 'users' },
    );

    expect(expanded.sql).toBe('select * from public.users where ;');
    expect(expanded.missingVariables).toEqual(['condition']);
  });

  it('treats corrupt user snippet storage as empty so built-ins still work', async () => {
    const filePath = await snippetPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');
    const store = new SqlSnippetStore(filePath);

    await expect(store.listUser()).resolves.toEqual([]);
    await expect(store.resolve('sel')).resolves.toMatchObject({
      trigger: 'sel',
      source: 'builtin',
    });
  });
});
