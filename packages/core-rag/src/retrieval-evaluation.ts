import type {
  SchemaRagEvaluationCase,
  SchemaRagEvaluationCaseResult,
  SchemaRagEvaluationSummary,
  SchemaRagSearchRequest,
  SchemaRagSearchResult,
} from './types.js';

export type SchemaRagSearchRunner = (request: SchemaRagSearchRequest) => SchemaRagSearchResult[];

export function evaluateSchemaRagRetrieval(input: {
  connectionId: string;
  cases: SchemaRagEvaluationCase[];
  search: SchemaRagSearchRunner;
  defaultLimit?: number;
}): SchemaRagEvaluationSummary {
  const results = input.cases.map((testCase) =>
    evaluateCase(input.connectionId, testCase, input.search, input.defaultLimit),
  );
  const passedCases = results.filter((result) => result.passed).length;
  return {
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    passRate: ratio(passedCases, results.length),
    averageMustHitRate: average(results.map((result) => result.mustHitRate)),
    averageShouldHitRate: average(results.map((result) => result.shouldHitRate)),
    results,
  };
}

function evaluateCase(
  connectionId: string,
  testCase: SchemaRagEvaluationCase,
  search: SchemaRagSearchRunner,
  defaultLimit = 8,
): SchemaRagEvaluationCaseResult {
  const retrievedIds = search({
    connectionId,
    query: testCase.query,
    limit: testCase.limit ?? defaultLimit,
    includeRelations: testCase.includeRelations ?? true,
  }).map((result) => result.document.id);
  const retrieved = new Set(retrievedIds);
  const missingMustInclude = testCase.mustInclude.filter((id) => !retrieved.has(id));
  const shouldInclude = testCase.shouldInclude ?? [];
  const missingShouldInclude = shouldInclude.filter((id) => !retrieved.has(id));
  const unexpectedIds = (testCase.mustNotInclude ?? []).filter((id) => retrieved.has(id));
  const mustHitRate = ratio(testCase.mustInclude.length - missingMustInclude.length, testCase.mustInclude.length);
  const shouldHitRate = ratio(shouldInclude.length - missingShouldInclude.length, shouldInclude.length);

  return {
    id: testCase.id,
    query: testCase.query,
    retrievedIds,
    missingMustInclude,
    missingShouldInclude,
    unexpectedIds,
    mustHitRate,
    shouldHitRate,
    passed: missingMustInclude.length === 0 && unexpectedIds.length === 0,
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
