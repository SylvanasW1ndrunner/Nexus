import { describe, expect, it } from 'vitest';
import { buildImportExecutionPlan, parseCsvImportPreview, parseJsonImportPreview } from '../src/index.js';

describe('import wizard backend plan', () => {
  it('parses CSV preview rows with headers, quotes, and truncation', () => {
    const preview = parseCsvImportPreview('email,status,note\nalice@example.com,active,"hello, csv"\nbob@example.com,,plain\n', {
      previewRows: 1,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.columns.map((column) => column.name)).toEqual(['email', 'status', 'note']);
    expect(preview.data.rows).toEqual([
      { rowNumber: 2, values: { email: 'alice@example.com', status: 'active', note: 'hello, csv' } },
    ]);
    expect(preview.data.totalRows).toBe(2);
    expect(preview.data.truncated).toBe(true);
  });

  it('parses JSON object arrays and stringifies nested values for preview', () => {
    const preview = parseJsonImportPreview(
      JSON.stringify([
        { id: 1, email: 'alice@example.com', profile: { city: 'Shanghai' } },
        { id: 2, email: 'bob@example.com', active: true },
      ]),
    );

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.columns.map((column) => column.name)).toEqual(['id', 'email', 'profile', 'active']);
    expect(preview.data.rows[0]?.values).toEqual({
      id: 1,
      email: 'alice@example.com',
      profile: '{"city":"Shanghai"}',
      active: null,
    });
  });

  it('builds batched INSERT SQL with mapped columns and parameters', () => {
    const plan = buildImportExecutionPlan({
      schema: 'public',
      table: 'users',
      mode: 'insert',
      batchSize: 2,
      rows: [
        { rowNumber: 2, values: { email: 'alice@example.com', status: 'active' } },
        { rowNumber: 3, values: { email: 'bob@example.com', status: '' } },
        { rowNumber: 4, values: { email: 'cindy@example.com', status: 'active' } },
      ],
      mappings: [
        { sourceColumn: 'email', targetColumn: 'email' },
        { sourceColumn: 'status', targetColumn: 'status', defaultValue: 'pending', skipEmpty: true },
      ],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.totalRows).toBe(3);
    expect(plan.data.batchSize).toBe(2);
    expect(plan.data.batches).toHaveLength(2);
    expect(plan.data.batches[0]).toEqual({
      index: 0,
      sql: ['insert into "public"."users" ("email", "status")', 'values ($1, $2), ($3, $4);'].join('\n'),
      params: ['alice@example.com', 'active', 'bob@example.com', 'pending'],
      rowNumbers: [2, 3],
    });
  });

  it('builds UPSERT SQL with conflict columns and update assignments', () => {
    const plan = buildImportExecutionPlan({
      schema: 'public',
      table: 'users',
      mode: 'upsert',
      conflictColumns: ['email'],
      rows: [{ rowNumber: 1, values: { email: 'alice@example.com', status: 'active' } }],
      mappings: [
        { sourceColumn: 'email', targetColumn: 'email' },
        { sourceColumn: 'status', targetColumn: 'status' },
      ],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.batches[0]?.sql).toBe(
      [
        'insert into "public"."users" ("email", "status")',
        'values ($1, $2)',
        'on conflict ("email")',
        'do update set "status" = excluded."status";',
      ].join('\n'),
    );
  });

  it('adds truncate prelude for truncate-insert imports', () => {
    const plan = buildImportExecutionPlan({
      schema: 'public',
      table: 'users',
      mode: 'truncate-insert',
      rows: [{ rowNumber: 1, values: { email: 'alice@example.com' } }],
      mappings: [{ sourceColumn: 'email', targetColumn: 'email' }],
      transactionMode: 'batch',
      errorHandling: 'skip',
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.preludeSql).toEqual(['truncate table "public"."users";']);
    expect(plan.data.transactionMode).toBe('batch');
    expect(plan.data.errorHandling).toBe('skip');
    expect(plan.data.warnings).toEqual(['Skip-on-error requires batch transaction mode or row-level retry by the caller.']);
  });

  it('rejects invalid import plans before SQL generation', () => {
    const upsert = buildImportExecutionPlan({
      schema: 'public',
      table: 'users',
      mode: 'upsert',
      rows: [{ rowNumber: 1, values: { email: 'alice@example.com' } }],
      mappings: [{ sourceColumn: 'email', targetColumn: 'email' }],
    });
    expect(upsert.ok).toBe(false);
    if (upsert.ok) return;
    expect(upsert.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'UPSERT import requires conflict columns.' });
  });

  it('rejects malformed CSV and JSON sources', () => {
    const csv = parseCsvImportPreview('email\n"alice@example.com');
    expect(csv.ok).toBe(false);
    if (csv.ok) return;
    expect(csv.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'CSV source has an unclosed quoted field.' });

    const json = parseJsonImportPreview('[1, 2, 3]');
    expect(json.ok).toBe(false);
    if (json.ok) return;
    expect(json.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'JSON import source must be an object or an array of objects.',
    });
  });
});
