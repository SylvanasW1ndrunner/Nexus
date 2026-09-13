import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  DATABASE_ANALYSIS_SCENARIOS,
  createDatabaseAnalysisFixture,
  dropDatabaseAnalysisFixture,
  parseAnalysisResult,
} from './database-analysis-live-fixtures.js';

const require = createRequire(import.meta.url);
const databaseUrl = process.env.DATABASE_URL ?? process.env.SCHEMANAUT_TEST_POSTGRES_URL;

describe('database analysis live fixtures', () => {
  it('exposes exactly the live analysis scenarios', () => {
    expect(DATABASE_ANALYSIS_SCENARIOS).toEqual([
      'database-commerce-analysis',
      'database-churn-ml',
      'database-fraud-investigation',
    ]);
  });

  it('parses the JSON following the final analysis marker', () => {
    expect(parseAnalysisResult('Summary\nANALYSIS_RESULT {"scenario":"database-commerce-analysis","metrics":{"revenue":42}}')).toEqual({
      scenario: 'database-commerce-analysis',
      metrics: { revenue: 42 },
    });
  });

  it('rejects a missing or malformed final analysis marker', () => {
    expect(() => parseAnalysisResult('no machine-readable result')).toThrow(/ANALYSIS_RESULT/);
    expect(() => parseAnalysisResult('ANALYSIS_RESULT {not json}')).toThrow(/valid JSON/);
  });

  it('requires one bounded churn sample before materializing complete NDJSON for Python', async () => {
    const churn = await createDatabaseAnalysisFixture(oracleOnlyClient({
      sample_count: '150', churned_count: '50', active_count: '100',
    }), 'database-churn-ml');
    const fraud = await createDatabaseAnalysisFixture(oracleOnlyClient({
      total_transactions: '1500', total_chargebacks: '45', chargeback_rate: '0.03',
    }), 'database-fraud-investigation');

    expect(churn.prompt).toMatch(/result_read exactly once with mode "record" and limit 40/i);
    expect(churn.prompt).toMatch(/exactly once/i);
    expect(churn.prompt).toMatch(/result_materialize/i);
    expect(churn.prompt).toMatch(/complete NDJSON/i);
    expect(churn.prompt).toMatch(/temporaryPath/i);
    expect(churn.prompt).not.toMatch(/nextCursor.*until eof/i);
    expect(churn.prompt).toMatch(/do not create churn_features\.csv/i);

    expect(fraud.prompt).toMatch(/result_read in record mode/i);
    expect(fraud.prompt).toMatch(/at most 40 records per page/i);
    expect(fraud.prompt).toMatch(/nextCursor.*until eof/i);
  });

  it('generates distinct PostgreSQL-safe schema names for every analysis scenario', async () => {
    const fixtures = await Promise.all([
      createDatabaseAnalysisFixture(oracleOnlyClient({
        total_revenue: '1000', category: 'Electronics', revenue: '600', repeat_customer_count: '12', month: '2025-09',
      }), 'database-commerce-analysis'),
      createDatabaseAnalysisFixture(oracleOnlyClient({
        sample_count: '150', churned_count: '50', active_count: '100',
      }), 'database-churn-ml'),
      createDatabaseAnalysisFixture(oracleOnlyClient({
        total_transactions: '1500', total_chargebacks: '45', chargeback_rate: '0.03',
      }), 'database-fraud-investigation'),
    ]);

    const schemaNames = fixtures.map(fixture => fixture.schemaName);
    expect(schemaNames).toHaveLength(new Set(schemaNames).size);
    for (const [index, scenario] of DATABASE_ANALYSIS_SCENARIOS.entries()) {
      const schemaName = schemaNames[index]!;
      const scenarioKey = scenario.replace('database-', '').replaceAll('-', '_');
      expect(schemaName).toMatch(new RegExp(`^live_analysis_${scenarioKey}_[a-f0-9]{24}$`));
      expect(Buffer.byteLength(schemaName, 'ascii')).toBeLessThanOrEqual(63);
    }
  });
});

describe.skipIf(!databaseUrl)('database analysis fixture PostgreSQL oracles', () => {
  it.each(DATABASE_ANALYSIS_SCENARIOS)('creates deterministic %s fixture data and removes its unique schema', async (scenario) => {
    const client = new (postgresClientConstructor())({ connectionString: databaseUrl! });
    await client.connect();
    let fixture: Awaited<ReturnType<typeof createDatabaseAnalysisFixture>> | undefined;
    try {
      fixture = await createDatabaseAnalysisFixture(client, scenario);
      expect(fixture.schemaName).toMatch(/^live_analysis_[a-z_]+_[a-f0-9]{24}$/);
      if (scenario === 'database-commerce-analysis') {
        expect(fixture.oracle.totalRevenue).toBeGreaterThan(0);
        expect(fixture.oracle.repeatCustomerCount).toBeGreaterThan(0);
        expect(fixture.oracle.anomaly).toMatchObject({ month: '2025-09' });
      }
      if (scenario === 'database-churn-ml') {
        expect(fixture.oracle).toMatchObject({ sampleCount: 150, majorityBaseline: 2 / 3, minimumAccuracy: 0.8 });
        expect(fixture.expectedWorkspaceFiles).toEqual(['churn_analysis.py', 'churn_metrics.json']);
      }
      if (scenario === 'database-fraud-investigation') {
        const topMerchants = await client.query(`
          SELECT t.merchant_id
          FROM "${fixture.schemaName}"."transactions" t
          LEFT JOIN "${fixture.schemaName}"."chargebacks" c ON c.transaction_id = t.transaction_id
          GROUP BY t.merchant_id
          ORDER BY COUNT(c.chargeback_id)::numeric / COUNT(t.transaction_id) DESC,
            AVG(t.amount) DESC, t.merchant_id
          LIMIT 5
        `);
        expect(topMerchants.rows.map(row => row.merchant_id)).toEqual(expect.arrayContaining(['m_005', 'm_017', 'm_031']));
        expect(fixture.expectedWorkspaceFiles).toEqual(['merchant_features.csv', 'fraud_analysis.py', 'fraud_scores.json']);
      }
    } finally {
      if (fixture !== undefined) await dropDatabaseAnalysisFixture(client, fixture);
      await client.end();
    }
  }, 30_000);
});

type PostgresClient = Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type PostgresClientConstructor = new (input: { connectionString: string }) => PostgresClient;

function postgresClientConstructor(): PostgresClientConstructor {
  const module = require('pg') as { Client?: unknown };
  if (typeof module.Client !== 'function') throw new Error('The pg Client is unavailable for fixture tests.');
  return module.Client as PostgresClientConstructor;
}

function oracleOnlyClient(oracleRow: Record<string, string>) {
  return {
    query(sql: string) {
      return Promise.resolve({
        rows: Object.keys(oracleRow).some(column => sql.includes(column)) ? [oracleRow] : [],
      });
    },
  };
}
