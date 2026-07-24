#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  SchemaRagEngine,
  buildKnowledgeCatalog,
  diffKnowledgeCatalogs,
} from '../packages/core-rag/dist/index.js';
import { AiSqlResultStore } from '../packages/core-tools/dist/index.js';

const NODE_COUNT = 10_000;
const SEARCH_SAMPLES = 80;
const GRAPH_SAMPLES = 80;
const DIFF_SAMPLES = 100;
const BROWSE_SAMPLES = 500;
const RESULT_PAGE_SAMPLES = 1_000;
const ROOT_COMPARE_SAMPLES = 10_000;
const reportPath = resolve('reports/ai-sql/performance.json');
const observedAt = '2026-07-24T00:00:00.000Z';
const source = {
  sourceId: 'ai-sql-benchmark',
  sourceType: 'connector',
  connectionProfileId: 'ai-sql-benchmark',
  observedAt,
};

let dataset = createKnowledgeDataset();
const buildStartedAt = performance.now();
let catalog = buildKnowledgeCatalog({
  connectionId: 'ai-sql-benchmark',
  resources: dataset.resources,
  relations: dataset.relations,
  builtAt: observedAt,
});
const catalogBuildMs = performance.now() - buildStartedAt;
assert(catalog.rootIds.length === 1, 'Knowledge catalog root was not built');
assert(
  Object.keys(catalog.nodes).length === NODE_COUNT,
  `Expected ${NODE_COUNT} catalog nodes`,
);

const changedResources = dataset.resources.map((resource) =>
  resource.id === dataset.changedResourceId
    ? {
        ...resource,
        version: resource.version + 1,
        attributes: { ...resource.attributes, dataType: 'numeric(24,6)' },
      }
    : resource,
);
let changedCatalog = buildKnowledgeCatalog({
  connectionId: 'ai-sql-benchmark',
  resources: changedResources,
  relations: dataset.relations,
  builtAt: observedAt,
});
const initialDiff = diffKnowledgeCatalogs(catalog, changedCatalog);
assert(
  initialDiff.changedResources.length === 1 &&
    initialDiff.changedResources[0]?.resourceId === dataset.changedResourceId,
  'Merkle diff did not isolate the changed leaf',
);

const rootComparisonDurations = measure(ROOT_COMPARE_SAMPLES, () => {
  if (catalog.catalogRootHash === changedCatalog.catalogRootHash) {
    throw new Error('Changed catalogs unexpectedly have the same root');
  }
});
const diffDurations = measure(DIFF_SAMPLES, () => {
  const diff = diffKnowledgeCatalogs(catalog, changedCatalog);
  if (diff.changedResources.length !== 1) {
    throw new Error('Merkle diff returned an unstable result');
  }
});

let engine = new SchemaRagEngine();
engine.index({
  connectionId: 'ai-sql-benchmark',
  resources: dataset.resources,
  relations: dataset.relations,
  indexedAt: observedAt,
});
for (let index = 0; index < 10; index += 1) {
  engine.search(searchRequest(index));
}
const searchDurations = measure(SEARCH_SAMPLES, (index) => {
  const results = engine.search(searchRequest(index));
  if (results.length === 0) throw new Error('Benchmark search returned no documents');
});
const graphDurations = measure(GRAPH_SAMPLES, (index) => {
  const tableIndex = index % dataset.tableCount;
  const schemaIndex = tableIndex % dataset.schemaCount;
  const results = engine.search({
    connectionId: 'ai-sql-benchmark',
    query: `domain_${schemaIndex}.fact_${String(tableIndex).padStart(4, '0')}`,
    limit: 20,
    includeRelations: true,
    expandHops: 2,
  });
  if (!results.some((result) => result.reasons.includes('channel:graph'))) {
    throw new Error('Benchmark graph expansion produced no graph result');
  }
});

const wideResources = Array.from({ length: 10_000 }, (_, index) =>
  benchmarkResource({
    id: `wide-table:${index}`,
    kind: 'table',
    canonicalName: `wide.table_${String(index).padStart(5, '0')}`,
    displayName: `table_${String(index).padStart(5, '0')}`,
    attributes: { ordinal: index },
  }),
);
let wideEngine = new SchemaRagEngine();
const wideIndex = wideEngine.index({
  connectionId: 'ai-sql-wide-parent',
  resources: wideResources,
  relations: [],
  indexedAt: observedAt,
});
const wideRootId = wideIndex.catalog?.rootIds[0];
assert(wideRootId, 'Wide catalog root was not built');
for (let index = 0; index < 10; index += 1) {
  wideEngine.listResources({
    connectionId: 'ai-sql-wide-parent',
    parentId: wideRootId,
    limit: 200,
  });
}
const browseDurations = measure(BROWSE_SAMPLES, () => {
  const children = wideEngine.listResources({
    connectionId: 'ai-sql-wide-parent',
    parentId: wideRootId,
    limit: 200,
  });
  if (children.length !== 200) throw new Error('Wide child browse lost resources');
});

const resultStore = new AiSqlResultStore({
  createId: () => 'benchmark-result',
});
const stored = resultStore.put({
  sessionId: 'benchmark-session',
  connectionId: 'ai-sql-benchmark',
  result: benchmarkQueryResult(),
});
const resultPageDurations = measure(RESULT_PAGE_SAMPLES, (index) => {
  const page = resultStore.read({
    id: stored.id,
    sessionId: 'benchmark-session',
    cursor: String((index % 10) * 100),
    limit: 100,
  });
  if (page.returnedRowCount !== 100) {
    throw new Error('Result paging returned an incomplete page');
  }
});

const metrics = {
  catalogBuildMs: round(catalogBuildMs),
  rootHashComparisonMs: summarize(rootComparisonDurations),
  merkleDiffMs: summarize(diffDurations),
  directChildBrowseMs: summarize(browseDurations),
  localRetrievalMs: summarize(searchDurations),
  twoHopGraphRetrievalMs: summarize(graphDurations),
  cachedResultPageMs: summarize(resultPageDurations),
};
const thresholds = {
  catalogBuildMs: 1_500,
  rootHashComparisonP95Ms: 1,
  merkleDiffP95Ms: 20,
  directChildBrowseP95Ms: 20,
  localRetrievalP95Ms: 100,
  twoHopGraphRetrievalP95Ms: 50,
  cachedResultPageP95Ms: 10,
};
const checks = {
  catalogBuild: check(metrics.catalogBuildMs, thresholds.catalogBuildMs),
  rootHashComparison: check(
    metrics.rootHashComparisonMs.p95,
    thresholds.rootHashComparisonP95Ms,
  ),
  merkleDiff: check(metrics.merkleDiffMs.p95, thresholds.merkleDiffP95Ms),
  directChildBrowse: check(
    metrics.directChildBrowseMs.p95,
    thresholds.directChildBrowseP95Ms,
  ),
  localRetrieval: check(
    metrics.localRetrievalMs.p95,
    thresholds.localRetrievalP95Ms,
  ),
  twoHopGraphRetrieval: check(
    metrics.twoHopGraphRetrievalMs.p95,
    thresholds.twoHopGraphRetrievalP95Ms,
  ),
  cachedResultPage: check(
    metrics.cachedResultPageMs.p95,
    thresholds.cachedResultPageP95Ms,
  ),
};
const report = {
  kind: 'ai-sql-performance',
  status: Object.values(checks).every((item) => item.passed)
    ? 'passed'
    : 'failed',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    memory: {
      rssMiB: bytesToMiB(process.memoryUsage().rss),
      heapUsedMiB: bytesToMiB(process.memoryUsage().heapUsed),
    },
  },
  dataset: {
    catalogNodes: NODE_COUNT,
    resources: dataset.resources.length,
    relations: dataset.relations.length,
    tables: dataset.tableCount,
    searchableDocuments: engine.getIndexStatus('ai-sql-benchmark').documentCount,
    wideParentChildren: wideResources.length,
    cachedResultRows: 1_000,
    samples: {
      rootHashComparison: ROOT_COMPARE_SAMPLES,
      merkleDiff: DIFF_SAMPLES,
      localRetrieval: SEARCH_SAMPLES,
      twoHopGraphRetrieval: GRAPH_SAMPLES,
      directChildBrowse: BROWSE_SAMPLES,
      cachedResultPage: RESULT_PAGE_SAMPLES,
    },
  },
  measurement:
    'Deterministic local benchmark. Database, model, embedding provider and network latency are excluded.',
  thresholds,
  metrics,
  checks,
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
if (report.status !== 'passed') process.exitCode = 1;

engine.clear('ai-sql-benchmark');
wideEngine.clear('ai-sql-wide-parent');
dataset = undefined;
catalog = undefined;
changedCatalog = undefined;
engine = undefined;
wideEngine = undefined;

function createKnowledgeDataset() {
  const schemaCount = 9;
  const tableCount = 998;
  const resources = [
    benchmarkResource({
      id: 'database:benchmark',
      kind: 'database',
      canonicalName: 'benchmark',
      displayName: 'benchmark',
      attributes: { engine: 'benchmark' },
    }),
  ];
  const relations = [];
  for (let schemaIndex = 0; schemaIndex < schemaCount; schemaIndex += 1) {
    const schemaId = `schema:domain_${schemaIndex}`;
    resources.push(
      benchmarkResource({
        id: schemaId,
        kind: 'schema',
        canonicalName: `domain_${schemaIndex}`,
        displayName: `domain_${schemaIndex}`,
        attributes: { owner: 'benchmark' },
      }),
    );
    relations.push(
      benchmarkRelation(
        `contains:database-domain-${schemaIndex}`,
        'contains',
        'database:benchmark',
        schemaId,
      ),
    );
  }

  let changedResourceId = '';
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const schemaIndex = tableIndex % schemaCount;
    const tableName = `fact_${String(tableIndex).padStart(4, '0')}`;
    const tableId = `table:domain_${schemaIndex}.${tableName}`;
    resources.push(
      benchmarkResource({
        id: tableId,
        kind: 'table',
        canonicalName: `domain_${schemaIndex}.${tableName}`,
        displayName: tableName,
        attributes: {
          schema: `domain_${schemaIndex}`,
          table: tableName,
          comment: `Revenue metric fact table ${tableIndex}`,
        },
      }),
    );
    relations.push(
      benchmarkRelation(
        `contains:schema-${schemaIndex}-table-${tableIndex}`,
        'contains',
        `schema:domain_${schemaIndex}`,
        tableId,
      ),
    );

    const columnCount = tableIndex < 9 ? 10 : 9;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const columnName =
        columnIndex === 0
          ? 'id'
          : columnIndex === 1
            ? 'amount'
            : `metric_${columnIndex}`;
      const columnId = `column:domain_${schemaIndex}.${tableName}.${columnName}`;
      resources.push(
        benchmarkResource({
          id: columnId,
          kind: 'column',
          canonicalName: `domain_${schemaIndex}.${tableName}.${columnName}`,
          displayName: columnName,
          attributes: {
            schema: `domain_${schemaIndex}`,
            table: tableName,
            column: columnName,
            ordinal: columnIndex + 1,
            dataType: columnIndex === 1 ? 'numeric(18,2)' : 'bigint',
            nullable: columnIndex !== 0,
          },
        }),
      );
      relations.push(
        benchmarkRelation(
          `contains:table-${tableIndex}-column-${columnIndex}`,
          'contains',
          tableId,
          columnId,
        ),
      );
      changedResourceId = columnId;
    }
  }

  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const nextIndex = (tableIndex + 1) % tableCount;
    relations.push(
      benchmarkRelation(
        `references:table-${tableIndex}-${nextIndex}`,
        'references',
        tableIdFor(tableIndex, schemaCount),
        tableIdFor(nextIndex, schemaCount),
      ),
    );
  }

  return {
    resources,
    relations,
    changedResourceId,
    schemaCount,
    tableCount,
  };
}

function tableIdFor(tableIndex, schemaCount) {
  const schemaIndex = tableIndex % schemaCount;
  return `table:domain_${schemaIndex}.fact_${String(tableIndex).padStart(4, '0')}`;
}

function benchmarkResource({
  id,
  kind,
  canonicalName,
  displayName,
  attributes,
}) {
  return {
    id,
    kind,
    nativeId: id,
    canonicalName,
    displayName,
    attributes,
    version: 1,
    firstSeenAt: observedAt,
    updatedAt: observedAt,
    sources: [source],
  };
}

function benchmarkRelation(id, kind, fromResourceId, toResourceId) {
  return {
    id,
    kind,
    fromResourceId,
    toResourceId,
    version: 1,
    firstSeenAt: observedAt,
    updatedAt: observedAt,
    sources: [source],
  };
}

function searchRequest(index) {
  const tableIndex = (index * 97) % 998;
  const schemaIndex = tableIndex % 9;
  return {
    connectionId: 'ai-sql-benchmark',
    query: `domain_${schemaIndex}.fact_${String(tableIndex).padStart(4, '0')} revenue amount`,
    limit: 12,
    includeRelations: true,
    expandHops: 1,
  };
}

function benchmarkQueryResult() {
  return {
    queryId: 'benchmark-query',
    columns: [
      { name: 'id', dataType: 'bigint' },
      { name: 'amount', dataType: 'numeric' },
    ],
    rows: Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index + 1),
      amount: (index * 1.25).toFixed(2),
    })),
    rowCount: 1_000,
    returnedRowCount: 1_000,
    elapsedMs: 1,
    safety: {
      statementKind: 'SELECT',
      riskLevel: 'safe',
      requiresConfirmation: false,
      blocked: false,
      reasons: [],
    },
  };
}

function measure(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation(index);
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function summarize(values) {
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function check(actual, maximum) {
  return {
    actual,
    maximum,
    passed: actual <= maximum,
  };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
