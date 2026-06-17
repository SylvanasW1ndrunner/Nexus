import { describe, expect, it } from 'vitest';
import { buildTableEditPreview } from '../src/index.js';

describe('table edit preview builder', () => {
  it('builds insert, update, and delete SQL with quoted identifiers and escaped values', () => {
    const preview = buildTableEditPreview({
      schema: 'tenant "A"',
      table: 'Order Items',
      primaryKey: ['id'],
      operations: [
        {
          type: 'insert',
          values: {
            id: 10,
            label: "Alice's order",
            active: true,
            metadata: { channel: 'web' },
          },
        },
        {
          type: 'update',
          key: { id: 10 },
          values: { label: 'paid' },
        },
        {
          type: 'delete',
          key: { id: 11 },
        },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.riskLevel).toBe('dangerous');
    expect(preview.data.requiresConfirmation).toBe(true);
    expect(preview.data.sql).toBe(
      [
        `insert into "tenant ""A"""."Order Items" ("id", "label", "active", "metadata") values (10, 'Alice''s order', true, '{"channel":"web"}'::jsonb);`,
        `update "tenant ""A"""."Order Items" set "label" = 'paid' where "id" = 10;`,
        `delete from "tenant ""A"""."Order Items" where "id" = 11;`,
      ].join('\n'),
    );
  });

  it('requires primary keys for update and delete operations', () => {
    const preview = buildTableEditPreview({
      schema: 'public',
      table: 'events_without_pk',
      primaryKey: [],
      operations: [{ type: 'update', key: { id: 1 }, values: { label: 'x' } }],
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('Tables without primary keys cannot be edited safely'),
    });
  });

  it('rejects update operations that would mutate a primary key column', () => {
    const preview = buildTableEditPreview({
      schema: 'public',
      table: 'users',
      primaryKey: ['id'],
      operations: [{ type: 'update', key: { id: 1 }, values: { id: 2 } }],
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Primary key columns cannot be edited through table cell updates.',
    });
  });

  it('marks large edit batches as requiring extra confirmation', () => {
    const preview = buildTableEditPreview({
      schema: 'public',
      table: 'users',
      primaryKey: ['id'],
      maxOperationsBeforeExtraConfirmation: 2,
      operations: [
        { type: 'update', key: { id: 1 }, values: { city: 'Shanghai' } },
        { type: 'update', key: { id: 2 }, values: { city: 'Beijing' } },
        { type: 'update', key: { id: 3 }, values: { city: 'Shenzhen' } },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.requiresExtraConfirmation).toBe(true);
    expect(preview.data.warnings).toEqual(expect.arrayContaining([expect.stringContaining('requires extra confirmation')]));
  });

  it('rejects blank identifiers before building SQL', () => {
    const preview = buildTableEditPreview({
      schema: 'public',
      table: ' ',
      primaryKey: ['id'],
      operations: [{ type: 'delete', key: { id: 1 } }],
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Table name is required.' });
  });

  it('returns validation errors instead of throwing for unsupported runtime values', () => {
    const preview = buildTableEditPreview({
      schema: 'public',
      table: 'users',
      primaryKey: ['id'],
      operations: [
        {
          type: 'update',
          key: { id: 1 },
          values: { score: Number.POSITIVE_INFINITY },
        },
      ],
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Column score value must be a finite number.',
    });
  });
});
