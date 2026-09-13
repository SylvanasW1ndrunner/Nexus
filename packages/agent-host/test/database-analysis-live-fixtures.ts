import { randomUUID } from 'node:crypto';

export const DATABASE_ANALYSIS_SCENARIOS = [
  'database-commerce-analysis',
  'database-churn-ml',
  'database-fraud-investigation',
] as const;

export type DatabaseAnalysisScenarioName = (typeof DATABASE_ANALYSIS_SCENARIOS)[number];

export type PortableJson = null | boolean | number | string | readonly PortableJson[] | PortableJsonObject;
export interface PortableJsonObject {
  readonly [key: string]: PortableJson;
}

export type PostgresQueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;
export type PostgresClient = Readonly<{
  query(sql: string): Promise<PostgresQueryResult>;
}>;

export type DatabaseAnalysisFixture = Readonly<{
  scenario: DatabaseAnalysisScenarioName;
  schemaName: string;
  prompt: string;
  oracle: PortableJsonObject;
  expectedWorkspaceFiles?: readonly string[];
}>;

export async function createDatabaseAnalysisFixture(
  client: PostgresClient,
  scenario: DatabaseAnalysisScenarioName,
): Promise<DatabaseAnalysisFixture> {
  const schemaName = `live_analysis_${scenario.replaceAll('database-', '').replaceAll('-', '_')}_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  try {
    switch (scenario) {
      case 'database-commerce-analysis':
        return await createCommerceFixture(client, schemaName);
      case 'database-churn-ml':
        return await createChurnFixture(client, schemaName);
      case 'database-fraud-investigation':
        return await createFraudFixture(client, schemaName);
    }
  } catch (error) {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => undefined);
    throw error;
  }
}

export function dropDatabaseAnalysisFixture(
  client: PostgresClient,
  fixture: Pick<DatabaseAnalysisFixture, 'schemaName'>,
): Promise<void> {
  return client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(fixture.schemaName)} CASCADE`).then(() => undefined);
}

export function parseAnalysisResult(finalText: string): PortableJsonObject {
  const marker = 'ANALYSIS_RESULT';
  const markerIndex = finalText.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`Expected final ${marker} marker in the Agent response.`);
  const jsonText = finalText.slice(markerIndex + marker.length).trim();
  if (!jsonText) throw new Error(`${marker} must be followed by a JSON object.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${marker} must be followed by valid JSON: ${reason}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${marker} JSON must be an object.`);
  }
  return parsed as PortableJsonObject;
}

async function createCommerceFixture(client: PostgresClient, schemaName: string): Promise<DatabaseAnalysisFixture> {
  const customers = qualified(schemaName, 'customers');
  const products = qualified(schemaName, 'products');
  const campaigns = qualified(schemaName, 'campaigns');
  const orders = qualified(schemaName, 'orders');
  const orderItems = qualified(schemaName, 'order_items');
  await client.query(`
    CREATE TABLE ${customers} (
      customer_id integer PRIMARY KEY,
      customer_name text NOT NULL,
      region text NOT NULL,
      signup_date date NOT NULL
    );
    CREATE TABLE ${products} (
      product_id integer PRIMARY KEY,
      product_name text NOT NULL,
      category text NOT NULL,
      list_price numeric(12,2) NOT NULL
    );
    CREATE TABLE ${campaigns} (
      campaign_id integer PRIMARY KEY,
      campaign_name text NOT NULL,
      channel text NOT NULL
    );
    CREATE TABLE ${orders} (
      order_id integer PRIMARY KEY,
      customer_id integer NOT NULL REFERENCES ${customers}(customer_id),
      campaign_id integer REFERENCES ${campaigns}(campaign_id),
      ordered_at date NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE ${orderItems} (
      order_item_id integer PRIMARY KEY,
      order_id integer NOT NULL REFERENCES ${orders}(order_id),
      product_id integer NOT NULL REFERENCES ${products}(product_id),
      quantity integer NOT NULL,
      unit_price numeric(12,2) NOT NULL
    )
  `);
  await insertRows(client, customers, ['customer_id', 'customer_name', 'region', 'signup_date'], Array.from({ length: 48 }, (_, index) => {
    const id = index + 1;
    return [id, `Customer ${String(id).padStart(2, '0')}`, ['East', 'West', 'North', 'South'][index % 4]!, `2024-${String((index % 11) + 1).padStart(2, '0')}-15`];
  }));
  await insertRows(client, products, ['product_id', 'product_name', 'category', 'list_price'], [
    [1, 'Orbit Laptop Sleeve', 'Electronics', 120],
    [2, 'Halo Wireless Charger', 'Electronics', 75],
    [3, 'Cedar Desk Lamp', 'Home', 48],
    [4, 'Linen Storage Bin', 'Home', 32],
    [5, 'Stride Bottle', 'Sports', 24],
    [6, 'Trail Daypack', 'Sports', 68],
    [7, 'Paper Notebook Set', 'Office', 18],
    [8, 'Focus Pen Pack', 'Office', 12],
  ]);
  await insertRows(client, campaigns, ['campaign_id', 'campaign_name', 'channel'], [
    [1, 'New year email', 'email'],
    [2, 'Search always-on', 'search'],
    [3, 'Partner referral', 'partner'],
  ]);
  const orderRows: PortableJson[][] = [];
  const itemRows: PortableJson[][] = [];
  let orderId = 1;
  let itemId = 1;
  for (let month = 1; month <= 12; month += 1) {
    const normalOrders = month === 9 ? 12 : 6;
    for (let sequence = 0; sequence < normalOrders; sequence += 1) {
      const isAnomaly = month === 9 && sequence >= 4;
      const status = sequence === 5 && month % 3 === 0 ? 'cancelled' : 'completed';
      const customerId = isAnomaly ? ((sequence % 8) + 1) : (((month * 5 + sequence * 7) % 48) + 1);
      const productId = isAnomaly ? (sequence % 2) + 1 : (((month + sequence * 2) % 8) + 1);
      orderRows.push([orderId, customerId, (sequence % 3) + 1, `2025-${String(month).padStart(2, '0')}-${String(4 + sequence * 2).padStart(2, '0')}`, status]);
      itemRows.push([itemId++, orderId, productId, isAnomaly ? 4 : ((sequence % 3) + 1), [120, 75, 48, 32, 24, 68, 18, 12][productId - 1]!]);
      if (!isAnomaly && sequence % 2 === 0) {
        const secondProductId = (productId % 8) + 1;
        itemRows.push([itemId++, orderId, secondProductId, 1, [120, 75, 48, 32, 24, 68, 18, 12][secondProductId - 1]!]);
      }
      orderId += 1;
    }
  }
  await insertRows(client, orders, ['order_id', 'customer_id', 'campaign_id', 'ordered_at', 'status'], orderRows);
  await insertRows(client, orderItems, ['order_item_id', 'order_id', 'product_id', 'quantity', 'unit_price'], itemRows);

  const totals = singleRow(await client.query(`
    SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text AS total_revenue
    FROM ${orders} o JOIN ${orderItems} oi ON oi.order_id = o.order_id
    WHERE o.status = 'completed'
  `));
  const category = singleRow(await client.query(`
    SELECT p.category, SUM(oi.quantity * oi.unit_price)::text AS revenue
    FROM ${orders} o
    JOIN ${orderItems} oi ON oi.order_id = o.order_id
    JOIN ${products} p ON p.product_id = oi.product_id
    WHERE o.status = 'completed'
    GROUP BY p.category ORDER BY SUM(oi.quantity * oi.unit_price) DESC, p.category LIMIT 1
  `));
  const repeat = singleRow(await client.query(`
    SELECT COUNT(*)::text AS repeat_customer_count
    FROM (
      SELECT o.customer_id FROM ${orders} o
      WHERE o.status = 'completed'
      GROUP BY o.customer_id HAVING COUNT(*) >= 2
    ) repeated
  `));
  const anomaly = singleRow(await client.query(`
    SELECT to_char(o.ordered_at, 'YYYY-MM') AS month, SUM(oi.quantity * oi.unit_price)::text AS revenue
    FROM ${orders} o JOIN ${orderItems} oi ON oi.order_id = o.order_id
    WHERE o.status = 'completed'
    GROUP BY to_char(o.ordered_at, 'YYYY-MM')
    ORDER BY SUM(oi.quantity * oi.unit_price) DESC, to_char(o.ordered_at, 'YYYY-MM') LIMIT 1
  `));
  const oracle: PortableJsonObject = {
    totalRevenue: numeric(totals.total_revenue, 'commerce total revenue'),
    topCategory: { category: text(category.category, 'commerce top category'), revenue: numeric(category.revenue, 'commerce category revenue') },
    repeatCustomerCount: numeric(repeat.repeat_customer_count, 'commerce repeat customer count'),
    anomaly: { month: text(anomaly.month, 'commerce anomaly month'), revenue: numeric(anomaly.revenue, 'commerce anomaly revenue') },
  };
  return {
    scenario: 'database-commerce-analysis',
    schemaName,
    prompt: commercePrompt(schemaName),
    oracle,
  };
}

async function createChurnFixture(client: PostgresClient, schemaName: string): Promise<DatabaseAnalysisFixture> {
  const accounts = qualified(schemaName, 'accounts');
  const subscriptions = qualified(schemaName, 'subscriptions');
  const usageDaily = qualified(schemaName, 'usage_daily');
  const supportTickets = qualified(schemaName, 'support_tickets');
  await client.query(`
    CREATE TABLE ${accounts} (
      account_id integer PRIMARY KEY,
      account_name text NOT NULL,
      plan text NOT NULL,
      region text NOT NULL,
      created_at date NOT NULL
    );
    CREATE TABLE ${subscriptions} (
      subscription_id integer PRIMARY KEY,
      account_id integer NOT NULL REFERENCES ${accounts}(account_id),
      started_at date NOT NULL,
      monthly_fee numeric(10,2) NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE ${usageDaily} (
      account_id integer NOT NULL REFERENCES ${accounts}(account_id),
      usage_date date NOT NULL,
      active_events integer NOT NULL,
      PRIMARY KEY (account_id, usage_date)
    );
    CREATE TABLE ${supportTickets} (
      ticket_id integer PRIMARY KEY,
      account_id integer NOT NULL REFERENCES ${accounts}(account_id),
      opened_at date NOT NULL,
      severity text NOT NULL
    )
  `);
  const accountRows: PortableJson[][] = [];
  const subscriptionRows: PortableJson[][] = [];
  const usageRows: PortableJson[][] = [];
  const ticketRows: PortableJson[][] = [];
  let ticketId = 1;
  for (let accountId = 1; accountId <= 150; accountId += 1) {
    const churned = accountId % 3 === 0;
    const tenureDays = churned ? 24 + (accountId % 31) : 150 + (accountId % 330);
    const createdAt = dateBefore('2025-06-30', tenureDays);
    accountRows.push([accountId, `Account ${String(accountId).padStart(3, '0')}`, ['Starter', 'Growth', 'Scale'][accountId % 3]!, ['East', 'West', 'Europe'][accountId % 3]!, createdAt]);
    subscriptionRows.push([accountId, accountId, createdAt, [49, 129, 299][accountId % 3]!, churned ? 'cancelled' : 'active']);
    for (let offset = 27; offset >= 0; offset -= 1) {
      const recent = offset < 14;
      const events = churned
        ? (recent ? 1 + (accountId % 3) : 11 + (accountId % 5))
        : (recent ? 8 + (accountId % 5) : 9 + (accountId % 5));
      usageRows.push([accountId, dateBefore('2025-06-30', offset), events]);
    }
    const ticketCount = churned ? 2 + (accountId % 2) : (accountId % 17 === 0 ? 1 : 0);
    for (let ticket = 0; ticket < ticketCount; ticket += 1) {
      ticketRows.push([ticketId++, accountId, dateBefore('2025-06-30', 2 + ticket * 5), churned ? 'high' : 'low']);
    }
  }
  await insertRows(client, accounts, ['account_id', 'account_name', 'plan', 'region', 'created_at'], accountRows);
  await insertRows(client, subscriptions, ['subscription_id', 'account_id', 'started_at', 'monthly_fee', 'status'], subscriptionRows);
  await insertRows(client, usageDaily, ['account_id', 'usage_date', 'active_events'], usageRows);
  await insertRows(client, supportTickets, ['ticket_id', 'account_id', 'opened_at', 'severity'], ticketRows);

  const counts = singleRow(await client.query(`
    SELECT COUNT(*)::text AS sample_count,
      COUNT(*) FILTER (WHERE status = 'cancelled')::text AS churned_count,
      COUNT(*) FILTER (WHERE status = 'active')::text AS active_count
    FROM ${subscriptions}
  `));
  const sampleCount = numeric(counts.sample_count, 'churn sample count');
  const churnedCount = numeric(counts.churned_count, 'churned account count');
  const activeCount = numeric(counts.active_count, 'active account count');
  const oracle: PortableJsonObject = {
    sampleCount,
    churnedCount,
    activeCount,
    majorityBaseline: Math.max(churnedCount, activeCount) / sampleCount,
    minimumAccuracy: 0.8,
    expectedRiskFactors: ['usage_drop', 'support_tickets', 'short_tenure'],
  };
  return {
    scenario: 'database-churn-ml',
    schemaName,
    prompt: churnPrompt(schemaName),
    oracle,
    expectedWorkspaceFiles: ['churn_analysis.py', 'churn_metrics.json'],
  };
}

async function createFraudFixture(client: PostgresClient, schemaName: string): Promise<DatabaseAnalysisFixture> {
  const merchants = qualified(schemaName, 'merchants');
  const transactions = qualified(schemaName, 'transactions');
  const chargebacks = qualified(schemaName, 'chargebacks');
  await client.query(`
    CREATE TABLE ${merchants} (
      merchant_id text PRIMARY KEY,
      merchant_name text NOT NULL,
      category text NOT NULL,
      joined_at date NOT NULL
    );
    CREATE TABLE ${transactions} (
      transaction_id integer PRIMARY KEY,
      merchant_id text NOT NULL REFERENCES ${merchants}(merchant_id),
      transacted_at timestamp NOT NULL,
      amount numeric(12,2) NOT NULL,
      card_country text NOT NULL,
      approved boolean NOT NULL
    );
    CREATE TABLE ${chargebacks} (
      chargeback_id integer PRIMARY KEY,
      transaction_id integer NOT NULL REFERENCES ${transactions}(transaction_id),
      opened_at date NOT NULL,
      reason text NOT NULL
    )
  `);
  const injectedMerchantIds = ['m_005', 'm_017', 'm_031'];
  const merchantRows: PortableJson[][] = [];
  const transactionRows: PortableJson[][] = [];
  const chargebackRows: PortableJson[][] = [];
  let transactionId = 1;
  let chargebackId = 1;
  for (let merchantNumber = 1; merchantNumber <= 40; merchantNumber += 1) {
    const merchantId = `m_${String(merchantNumber).padStart(3, '0')}`;
    const injected = injectedMerchantIds.includes(merchantId);
    merchantRows.push([merchantId, `Merchant ${String(merchantNumber).padStart(2, '0')}`, ['retail', 'digital', 'travel', 'food'][merchantNumber % 4]!, `2024-${String((merchantNumber % 11) + 1).padStart(2, '0')}-10`]);
    const transactionCount = injected ? 70 : 34 + (merchantNumber % 7);
    for (let sequence = 0; sequence < transactionCount; sequence += 1) {
      const amount = injected ? 320 + (sequence % 9) * 47 : 18 + ((merchantNumber * 13 + sequence * 7) % 90);
      const approved = injected ? sequence % 9 !== 0 : sequence % 29 !== 0;
      transactionRows.push([
        transactionId,
        merchantId,
        `2025-06-${String((sequence % 28) + 1).padStart(2, '0')} ${String(sequence % 24).padStart(2, '0')}:15:00`,
        amount,
        injected && sequence % 4 === 0 ? 'ZZ' : ['US', 'CA', 'GB', 'DE'][sequence % 4]!,
        approved,
      ]);
      const shouldChargeback = injected ? sequence % 5 === 0 : sequence === 0 && merchantNumber % 9 === 0;
      if (shouldChargeback) {
        chargebackRows.push([chargebackId++, transactionId, `2025-07-${String((sequence % 20) + 1).padStart(2, '0')}`, injected ? 'fraudulent' : 'customer_dispute']);
      }
      transactionId += 1;
    }
  }
  await insertRows(client, merchants, ['merchant_id', 'merchant_name', 'category', 'joined_at'], merchantRows);
  await insertRows(client, transactions, ['transaction_id', 'merchant_id', 'transacted_at', 'amount', 'card_country', 'approved'], transactionRows);
  await insertRows(client, chargebacks, ['chargeback_id', 'transaction_id', 'opened_at', 'reason'], chargebackRows);

  const counts = singleRow(await client.query(`
    SELECT COUNT(t.transaction_id)::text AS total_transactions,
      COUNT(c.chargeback_id)::text AS total_chargebacks,
      (COUNT(c.chargeback_id)::numeric / NULLIF(COUNT(t.transaction_id), 0))::text AS chargeback_rate
    FROM ${transactions} t LEFT JOIN ${chargebacks} c ON c.transaction_id = t.transaction_id
  `));
  const oracle: PortableJsonObject = {
    injectedMerchantIds,
    topK: 5,
    totalTransactions: numeric(counts.total_transactions, 'fraud transaction count'),
    totalChargebacks: numeric(counts.total_chargebacks, 'fraud chargeback count'),
    chargebackRate: numeric(counts.chargeback_rate, 'fraud chargeback rate'),
  };
  return {
    scenario: 'database-fraud-investigation',
    schemaName,
    prompt: fraudPrompt(schemaName),
    oracle,
    expectedWorkspaceFiles: ['merchant_features.csv', 'fraud_analysis.py', 'fraud_scores.json'],
  };
}

function commercePrompt(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return `You are analyzing a synthetic commerce business in PostgreSQL schema ${schema}. The tables are ${schema}."customers", ${schema}."products", ${schema}."campaigns", ${schema}."orders", and ${schema}."order_items". Use tool_search to activate the Database capability, then use sql_execute for at least two read-only SQL queries. Every revenue, category, repeat-purchase, and monthly-anomaly metric must include only orders where o.status = 'completed'. Your SQL must join across business tables (orders/order_items/products at minimum) and calculate total revenue, top category and its revenue, the count of customers with at least two completed orders, and the highest-revenue month. Do not use process_exec for SQL. A prose-only response ends the run: while any required metric is missing, call a tool instead of saying you will investigate it later. After all four metrics are observed, explain one actionable business interpretation grounded in them and finish with the final line exactly in this shape: ANALYSIS_RESULT {"scenario":"database-commerce-analysis","metrics":{"totalRevenue":number,"topCategory":{"category":string,"revenue":number},"repeatCustomerCount":number,"anomaly":{"month":"YYYY-MM","revenue":number}}}.`;
}

function churnPrompt(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return `You are building a reproducible churn analysis for PostgreSQL schema ${schema}. Use tool_search to activate Database. The schema contract is already known and must not be rediscovered: ${schema}."accounts" has account_id, plan, region, created_at; ${schema}."subscriptions" has account_id and status; ${schema}."usage_daily" has account_id, usage_date, active_events; ${schema}."support_tickets" has account_id and severity. Do not call resource_list, resource_get, schema inspection, or profiling queries. Your first database action must be one sql_execute query that returns exactly one account-level feature row per account: account_id, churn (status = 'cancelled'), tenure_days relative to DATE '2025-06-30', usage_recent for usage_date >= DATE '2025-06-17', usage_prior for earlier rows, ticket_count, high_tickets, plan, and region. Use no other database calls unless that feature query fails and needs correction. From its contentRef, call result_read exactly once with mode "record" and limit 40 only to understand the fields. Do not follow nextCursor, paginate to eof, or move the complete table through model context. Immediately call result_materialize with the same contentRef to materialize the complete NDJSON result. Use the returned temporaryPath directly from Python; do not create churn_features.csv. Use workspace_apply_patch to create exactly these project files: churn_analysis.py and churn_metrics.json. churn_analysis.py must use only the Python standard library (no pip or package installation), read the temporaryPath NDJSON line by line, train/evaluate a simple deterministic classifier, write churn_metrics.json, and print the same JSON object to stdout. The metrics object must include sampleCount, accuracy, majorityBaseline, and riskFactors. Use process_exec to run the script. Finish with a final ANALYSIS_RESULT JSON object whose scenario is "database-churn-ml" and whose metrics value is exactly the JSON object in churn_metrics.json. Do not send interim prose announcing a next action: make the Tool call instead, and do not claim success until the script has run.`;
}

function fraudPrompt(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return `Investigate merchant fraud risk in PostgreSQL schema ${schema}. The tables are ${schema}."merchants", ${schema}."transactions", and ${schema}."chargebacks". Use tool_search to activate Database. Perform at least two rounds of read-only sql_execute: first profile transactions, then run a merchant- and chargeback-focused follow-up query to test the risk hypothesis. If you use a SQL result reference to write merchant_features.csv, use result_read in record mode with at most 40 records per page and follow nextCursor until eof before writing the CSV. Create exactly merchant_features.csv, fraud_analysis.py, and fraud_scores.json with workspace_apply_patch. fraud_analysis.py must use only Python's standard library (never install packages), read the CSV, compute a deterministic merchant risk score, write fraud_scores.json, and print the same JSON object to stdout. The JSON must include an ordered topMerchants list plus totalTransactions, totalChargebacks, and chargebackRate. Use process_exec to execute the script. Finish with ANALYSIS_RESULT {"scenario":"database-fraud-investigation","metrics":...}, where metrics is exactly the JSON object written to fraud_scores.json. Give a concise reason for each high-risk merchant.`;
}

async function insertRows(
  client: PostgresClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly PortableJson[])[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(`INSERT INTO ${table} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${rows.map(row => `(${row.map(sqlLiteral).join(', ')})`).join(', ')}`);
}

function qualified(schemaName: string, tableName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: PortableJson): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Fixture SQL literals must be finite numbers.');
    return String(value);
  }
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('Fixture SQL literals must be scalar values.');
}

function singleRow(result: PostgresQueryResult): Record<string, unknown> {
  const row = result.rows[0];
  if (row === undefined) throw new Error('Expected PostgreSQL oracle query to return one row.');
  return row;
}

function numeric(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected ${label} to be a finite PostgreSQL number.`);
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be PostgreSQL text.`);
  return value;
}

function dateBefore(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
