import { describe, expect, it } from 'vitest';
import { buildTablePreviewSql, quotePgIdentifier } from '../src/index.js';

describe('PostgreSQL SQL builder', () => {
  it('quotes identifiers without changing valid names', () => {
    expect(quotePgIdentifier('orders')).toBe('"orders"');
  });

  it('escapes embedded quotes in schema and table names', () => {
    expect(buildTablePreviewSql('tenant "A"', 'Order Items', 50)).toBe(
      'select * from "tenant ""A"""."Order Items" limit 50;',
    );
  });

  it('clamps preview limits to a product-safe range', () => {
    expect(buildTablePreviewSql('public', 'users', 0)).toBe('select * from "public"."users" limit 1;');
    expect(buildTablePreviewSql('public', 'users', 5000)).toBe('select * from "public"."users" limit 1000;');
  });
});
