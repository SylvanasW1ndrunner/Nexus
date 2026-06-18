import { randomUUID } from 'node:crypto';
import type { Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

export type SqlSnippetSource = 'builtin' | 'user';

export type SqlSnippetVariable = {
  name: string;
  defaultValue?: string;
  description?: string;
};

export type SqlSnippet = {
  id: string;
  trigger: string;
  title: string;
  body: string;
  source: SqlSnippetSource;
  description?: string;
  variables?: SqlSnippetVariable[];
  createdAt?: string;
  updatedAt?: string;
};

export type SqlSnippetInput = {
  trigger: string;
  title: string;
  body: string;
  description?: string;
  variables?: SqlSnippetVariable[];
};

export type SqlSnippetSearchOptions = {
  query?: string;
  includeBuiltins?: boolean;
  includeUser?: boolean;
};

export type ExpandedSqlSnippet = {
  sql: string;
  missingVariables: string[];
  warnings: string[];
};

const triggerPattern = /^[a-z][a-z0-9-]{0,31}$/;
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const builtinSqlSnippets: SqlSnippet[] = [
  {
    id: 'builtin:sel',
    trigger: 'sel',
    title: 'Select rows',
    description: 'Query a table with a safe default limit.',
    body: ['select *', 'from {{schema}}.{{table}}', 'limit {{limit}};'].join('\n'),
    source: 'builtin',
    variables: [
      { name: 'schema', defaultValue: 'public', description: 'Schema name.' },
      { name: 'table', defaultValue: 'users', description: 'Table name.' },
      { name: 'limit', defaultValue: '100', description: 'Maximum rows.' },
    ],
  },
  {
    id: 'builtin:ins',
    trigger: 'ins',
    title: 'Insert row',
    description: 'Insert a row with explicit columns and values.',
    body: ['insert into {{schema}}.{{table}} ({{columns}})', 'values ({{values}});'].join('\n'),
    source: 'builtin',
    variables: [
      { name: 'schema', defaultValue: 'public' },
      { name: 'table', defaultValue: 'users' },
      { name: 'columns', defaultValue: 'column_name' },
      { name: 'values', defaultValue: '$1' },
    ],
  },
  {
    id: 'builtin:upd',
    trigger: 'upd',
    title: 'Update rows',
    description: 'Update rows with an explicit WHERE clause.',
    body: [
      'update {{schema}}.{{table}}',
      'set {{column}} = {{value}}',
      'where {{condition}};',
    ].join('\n'),
    source: 'builtin',
    variables: [
      { name: 'schema', defaultValue: 'public' },
      { name: 'table', defaultValue: 'users' },
      { name: 'column', defaultValue: 'status' },
      { name: 'value', defaultValue: '$1' },
      { name: 'condition', defaultValue: 'id = $2' },
    ],
  },
  {
    id: 'builtin:del',
    trigger: 'del',
    title: 'Delete rows',
    description: 'Delete rows with an explicit WHERE clause.',
    body: ['delete from {{schema}}.{{table}}', 'where {{condition}};'].join('\n'),
    source: 'builtin',
    variables: [
      { name: 'schema', defaultValue: 'public' },
      { name: 'table', defaultValue: 'users' },
      { name: 'condition', defaultValue: 'id = $1' },
    ],
  },
  {
    id: 'builtin:cre-table',
    trigger: 'cre-table',
    title: 'Create table',
    description: 'Create a table with an id primary key and timestamps.',
    body: [
      'create table {{schema}}.{{table}} (',
      '  id bigserial primary key,',
      '  {{column}} {{data_type}} not null,',
      '  created_at timestamptz not null default now()',
      ');',
    ].join('\n'),
    source: 'builtin',
    variables: [
      { name: 'schema', defaultValue: 'public' },
      { name: 'table', defaultValue: 'new_table' },
      { name: 'column', defaultValue: 'name' },
      { name: 'data_type', defaultValue: 'text' },
    ],
  },
  {
    id: 'builtin:cre-idx',
    trigger: 'cre-idx',
    title: 'Create index',
    description: 'Create a PostgreSQL btree index.',
    body: 'create index {{index}} on {{schema}}.{{table}} ({{columns}});',
    source: 'builtin',
    variables: [
      { name: 'index', defaultValue: 'idx_table_column' },
      { name: 'schema', defaultValue: 'public' },
      { name: 'table', defaultValue: 'users' },
      { name: 'columns', defaultValue: 'created_at' },
    ],
  },
];

export class SqlSnippetStore {
  constructor(private readonly filePath: string) {}

  async list(options: SqlSnippetSearchOptions = {}): Promise<SqlSnippet[]> {
    const includeBuiltins = options.includeBuiltins ?? true;
    const includeUser = options.includeUser ?? true;
    const snippets = [
      ...(includeBuiltins ? builtinSqlSnippets : []),
      ...(includeUser ? await this.listUser() : []),
    ];
    return filterAndSortSnippets(snippets, options.query);
  }

  async listUser(): Promise<SqlSnippet[]> {
    return normalizeStoredSnippets(await readJsonFile<SqlSnippet[]>(this.filePath, []));
  }

  async resolve(trigger: string): Promise<SqlSnippet | undefined> {
    const normalized = normalizeTrigger(trigger);
    const user = (await this.listUser()).find((snippet) => snippet.trigger === normalized);
    if (user) return user;
    return builtinSqlSnippets.find((snippet) => snippet.trigger === normalized);
  }

  async create(input: SqlSnippetInput): Promise<Result<SqlSnippet>> {
    const validation = validateSnippetInput(input, { rejectBuiltinTrigger: true });
    if (!validation.ok) return validation;

    const snippets = await this.listUser();
    if (snippets.some((snippet) => snippet.trigger === validation.data.trigger)) {
      return err({
        code: 'VALIDATION_ERROR',
        message: `SQL snippet trigger already exists: ${validation.data.trigger}.`,
      });
    }

    const now = new Date().toISOString();
    const snippet: SqlSnippet = {
      id: `user:${randomUUID()}`,
      source: 'user',
      createdAt: now,
      updatedAt: now,
      ...validation.data,
    };
    await this.saveUser([...snippets, snippet]);
    return ok(snippet);
  }

  async update(id: string, patch: Partial<SqlSnippetInput>): Promise<Result<SqlSnippet>> {
    const snippets = await this.listUser();
    const index = snippets.findIndex((snippet) => snippet.id === id);
    if (index === -1)
      return err({ code: 'NOT_FOUND', message: `SQL snippet was not found: ${id}.` });

    const current = snippets[index]!;
    const nextInput: SqlSnippetInput = {
      trigger: patch.trigger ?? current.trigger,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
    };
    const description = patch.description ?? current.description;
    const variables = patch.variables ?? current.variables;
    if (description !== undefined) nextInput.description = description;
    if (variables !== undefined) nextInput.variables = variables;

    const validation = validateSnippetInput(nextInput, { rejectBuiltinTrigger: true });
    if (!validation.ok) return validation;
    if (
      snippets.some((snippet) => snippet.id !== id && snippet.trigger === validation.data.trigger)
    ) {
      return err({
        code: 'VALIDATION_ERROR',
        message: `SQL snippet trigger already exists: ${validation.data.trigger}.`,
      });
    }

    const updated: SqlSnippet = {
      ...current,
      ...validation.data,
      updatedAt: new Date().toISOString(),
    };
    snippets[index] = updated;
    await this.saveUser(snippets);
    return ok(updated);
  }

  async remove(id: string): Promise<boolean> {
    const snippets = await this.listUser();
    const next = snippets.filter((snippet) => snippet.id !== id);
    if (next.length === snippets.length) return false;
    await this.saveUser(next);
    return true;
  }

  private async saveUser(snippets: SqlSnippet[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, filterAndSortSnippets(snippets));
  }
}

export function expandSqlSnippet(
  snippet: SqlSnippet,
  values: Record<string, unknown> = {},
): ExpandedSqlSnippet {
  const variableDefaults = new Map<string, string>();
  for (const variable of snippet.variables ?? []) {
    if (variable.defaultValue !== undefined)
      variableDefaults.set(variable.name, variable.defaultValue);
  }

  const missingVariables = new Set<string>();
  const sql = snippet.body.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_match, name: string) => {
      if (values[name] !== undefined && values[name] !== null) return String(values[name]);
      const fallback = variableDefaults.get(name);
      if (fallback !== undefined) return fallback;
      missingVariables.add(name);
      return '';
    },
  );

  return {
    sql,
    missingVariables: [...missingVariables].sort(),
    warnings: [
      'Snippet variables are inserted as SQL text; generated SQL must still pass normal execution review.',
    ],
  };
}

function validateSnippetInput(
  input: SqlSnippetInput,
  options: { rejectBuiltinTrigger: boolean },
): Result<SqlSnippetInput> {
  const trigger = normalizeTrigger(input.trigger);
  if (!triggerPattern.test(trigger)) {
    return err({
      code: 'VALIDATION_ERROR',
      message:
        'SQL snippet trigger must start with a letter and contain only lowercase letters, numbers, or hyphens.',
    });
  }
  if (
    options.rejectBuiltinTrigger &&
    builtinSqlSnippets.some((snippet) => snippet.trigger === trigger)
  ) {
    return err({
      code: 'VALIDATION_ERROR',
      message: `Built-in SQL snippet trigger cannot be overwritten: ${trigger}.`,
    });
  }

  const title = input.title.trim();
  if (!title) return err({ code: 'VALIDATION_ERROR', message: 'SQL snippet title is required.' });
  const body = input.body.trim();
  if (!body) return err({ code: 'VALIDATION_ERROR', message: 'SQL snippet body is required.' });
  if (hasNullByte(title) || hasNullByte(body) || hasNullByte(input.description ?? '')) {
    return err({ code: 'VALIDATION_ERROR', message: 'SQL snippet cannot contain null bytes.' });
  }

  const variables = normalizeVariables(input.variables);
  if (!variables.ok) return variables;

  return ok({
    trigger,
    title,
    body,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(variables.data.length > 0 ? { variables: variables.data } : {}),
  });
}

function normalizeVariables(
  variables: SqlSnippetVariable[] | undefined,
): Result<SqlSnippetVariable[]> {
  const seen = new Set<string>();
  const normalized: SqlSnippetVariable[] = [];

  for (const variable of variables ?? []) {
    const name = variable.name.trim();
    if (!variablePattern.test(name)) {
      return err({
        code: 'VALIDATION_ERROR',
        message: `SQL snippet variable name is invalid: ${variable.name}.`,
      });
    }
    if (seen.has(name)) {
      return err({
        code: 'VALIDATION_ERROR',
        message: `SQL snippet variable is duplicated: ${name}.`,
      });
    }
    seen.add(name);
    normalized.push({
      name,
      ...(variable.defaultValue !== undefined
        ? { defaultValue: String(variable.defaultValue) }
        : {}),
      ...(variable.description?.trim() ? { description: variable.description.trim() } : {}),
    });
  }

  return ok(normalized);
}

function normalizeStoredSnippets(snippets: SqlSnippet[]): SqlSnippet[] {
  return snippets
    .filter((snippet) => snippet.source === 'user' && snippet.id.startsWith('user:'))
    .filter(
      (snippet) =>
        triggerPattern.test(snippet.trigger) && snippet.title.trim() && snippet.body.trim(),
    )
    .map((snippet) => {
      const variables = snippet.variables?.filter((variable) =>
        variablePattern.test(variable.name),
      );
      return {
        ...snippet,
        trigger: normalizeTrigger(snippet.trigger),
        title: snippet.title.trim(),
        body: snippet.body.trim(),
        ...(variables && variables.length > 0 ? { variables } : {}),
      };
    });
}

function filterAndSortSnippets(snippets: SqlSnippet[], query?: string): SqlSnippet[] {
  const normalizedQuery = query?.trim().toLowerCase();
  return snippets
    .filter((snippet) => {
      if (!normalizedQuery) return true;
      return [snippet.trigger, snippet.title, snippet.description, snippet.body]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .sort(
      (left, right) =>
        left.trigger.localeCompare(right.trigger) || left.source.localeCompare(right.source),
    );
}

function normalizeTrigger(trigger: string): string {
  return trigger.trim().toLowerCase();
}

function hasNullByte(value: string): boolean {
  return value.includes('\0');
}
