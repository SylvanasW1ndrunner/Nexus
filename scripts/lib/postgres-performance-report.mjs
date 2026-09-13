export function mergePostgresPerformanceReports(reports, options = {}) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('At least one PostgreSQL performance report is required.');
  }
  const base = reports[0];
  const runId = base.runId;
  const configuration = withoutScenarioFilter(base.configuration);
  const environment = stableJson(base.environment);
  const scale = stableJson(base.scale);
  const scenarios = [];
  const names = new Set();

  for (const report of reports) {
    if (report.runId !== runId) {
      throw new Error('Isolated performance reports must belong to the same test run.');
    }
    if (stableJson(withoutScenarioFilter(report.configuration)) !== stableJson(configuration)) {
      throw new Error('Isolated performance reports must use the same benchmark configuration.');
    }
    if (stableJson(report.environment) !== environment || stableJson(report.scale) !== scale) {
      throw new Error('Isolated performance reports must use the same environment and fixture scale.');
    }
    if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) {
      throw new Error('Every isolated performance report must contain a scenario result.');
    }
    for (const scenario of report.scenarios) {
      if (names.has(scenario.name)) {
        throw new Error(`Duplicate isolated performance scenario: ${scenario.name}`);
      }
      names.add(scenario.name);
      scenarios.push(structuredClone(scenario));
    }
  }

  return {
    ...structuredClone(base),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration: {
      ...structuredClone(configuration),
      scenarioFilter: [],
      scenarioIsolation: 'fresh-process-per-scenario',
    },
    scenarios,
    passed: scenarios.every((scenario) => scenario.passed === true),
  };
}

function withoutScenarioFilter(configuration = {}) {
  const rest = { ...configuration };
  delete rest.scenarioFilter;
  delete rest.scenarioIsolation;
  return rest;
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}
