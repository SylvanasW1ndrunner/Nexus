import { describe, expect, it } from 'vitest';
import type { QueryExecutionResult } from '../src/index.js';
import { exportQueryResult, queryResultToCsv, queryResultToJson } from '../src/index.js';

const result: QueryExecutionResult = {
  queryId: 'query/export:1',
  columns: [{ name: 'id' }, { name: 'customer' }, { name: 'note' }, { name: 'metadata' }, { name: 'created_at' }],
  rows: [
    {
      id: 1,
      customer: 'Acme',
      note: 'first line\n"quoted", second line',
      metadata: { tier: 'enterprise' },
      created_at: new Date('2026-06-01T00:00:00.000Z'),
    },
    {
      id: 2,
      customer: 'Northwind',
      note: 'starter',
      metadata: { tier: 'starter' },
      created_at: new Date('2026-06-02T00:00:00.000Z'),
    },
    {
      id: 3n,
      customer: null,
      note: 'enterprise renewal',
      metadata: { tier: 'enterprise', raw: Buffer.from('ok') },
      created_at: new Date('2026-06-03T00:00:00.000Z'),
    },
  ],
  rowCount: 3,
  elapsedMs: 24,
  safety: {
    statementKind: 'SELECT',
    riskLevel: 'safe',
    requiresConfirmation: false,
    blocked: false,
    reasons: [],
  },
};

describe('query result export contract', () => {
  it('keeps the legacy CSV helper stable', () => {
    expect(queryResultToCsv({ ...result, rows: [result.rows[0]!] })).toBe(
      [
        'id,customer,note,metadata,created_at',
        '1,Acme,"first line\n""quoted"", second line","{""tier"":""enterprise""}",2026-06-01T00:00:00.000Z',
      ].join('\r\n'),
    );
  });

  it('keeps the legacy JSON helper stable', () => {
    const parsed = JSON.parse(queryResultToJson({ ...result, rows: [result.rows[0]!] }));
    expect(parsed).toMatchObject({
      queryId: 'query/export:1',
      rowCount: 3,
      rows: [
        {
          id: 1,
          customer: 'Acme',
          metadata: { tier: 'enterprise' },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    expect(parsed).not.toHaveProperty('exportedRowCount');
  });

  it('exports only the filtered visible result view', () => {
    const artifact = exportQueryResult(result, {
      format: 'json',
      baseName: '订单:筛选',
      visibleColumnNames: ['id', 'metadata'],
      searchText: 'enterprise',
      offset: 1,
      limit: 1,
    });

    expect(artifact.filename).toBe('订单_筛选.json');
    expect(artifact.rowCount).toBe(1);
    expect(artifact.columnCount).toBe(2);
    expect(JSON.parse(artifact.content)).toMatchObject({
      exportedRowCount: 1,
      filteredRowCount: 2,
      columns: [{ name: 'id' }, { name: 'metadata' }],
      rows: [{ id: '3', metadata: { tier: 'enterprise', raw: 'b2s=' } }],
    });
  });

  it('exports NDJSON rows for streaming-friendly downstream use', () => {
    const artifact = exportQueryResult(result, {
      format: 'ndjson',
      visibleColumnNames: ['id', 'customer'],
      searchText: 'north',
    });

    expect(artifact.filename).toBe('query-query_export_1.ndjson');
    expect(artifact.content).toBe('{"id":2,"customer":"Northwind"}\n');
  });

  it('exports an Excel-compatible XML workbook with result and metadata sheets', () => {
    const artifact = exportQueryResult(result, {
      format: 'excel-xml',
      baseName: 'result <unsafe>',
      visibleColumnNames: ['customer', 'note'],
      searchText: 'quoted',
    });

    expect(artifact.filename).toBe('result _unsafe_.xls');
    expect(artifact.mimeType).toBe('application/vnd.ms-excel;charset=utf-8');
    expect(artifact.content).toContain('<?mso-application progid="Excel.Sheet"?>');
    expect(artifact.content).toContain('<Worksheet ss:Name="Result">');
    expect(artifact.content).toContain('<Worksheet ss:Name="Metadata">');
    expect(artifact.content).toContain('&quot;quoted&quot;, second line');
    expect(artifact.content).toContain('exportedRowCount');
  });
});
