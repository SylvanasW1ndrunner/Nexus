import type { AgentEvalSuiteManifest } from './agent-eval-suite-manifest.js';
import type { AgentEvalSuite } from './agent-eval-suite-runner.js';
import {
  loadAgentEvalSuiteCatalog,
  type AgentEvalSuiteCatalogLoadOptions,
  type AgentEvalSuiteCatalogSource,
} from './agent-eval-suite-catalog.js';

export type AgentEvalSuiteCatalogServiceSourceKind = AgentEvalSuiteCatalogSource['kind'];

export type AgentEvalSuiteCatalogServiceEntry = {
  suiteId: string;
  suiteName: string;
  environment?: AgentEvalSuite['environment'];
  source: AgentEvalSuiteCatalogSource;
  sourceLabel: string;
  caseCount: number;
  caseIds: string[];
  notes: string[];
  declaredToolNames: string[];
  requiredToolNames: string[];
  allowedToolNames: string[];
  runModes: string[];
  readonlyOnly: boolean;
  manifest?: AgentEvalSuiteManifest;
  suite?: AgentEvalSuite;
};

export type AgentEvalSuiteCatalogServiceListOptions = AgentEvalSuiteCatalogLoadOptions & {
  suiteIds?: string[];
  sourceKinds?: AgentEvalSuiteCatalogServiceSourceKind[];
  environments?: NonNullable<AgentEvalSuite['environment']>[];
  includeManifest?: boolean;
  includeSuite?: boolean;
};

export type AgentEvalSuiteCatalogServiceGetOptions = Omit<
  AgentEvalSuiteCatalogServiceListOptions,
  'suiteIds'
> & {
  suiteId: string;
};

export type AgentEvalSuiteCatalogServiceListResult = {
  totalCount: number;
  entries: AgentEvalSuiteCatalogServiceEntry[];
};

export class AgentEvalSuiteCatalogService {
  constructor(private readonly defaults: AgentEvalSuiteCatalogLoadOptions = {}) {}

  async list(
    options: AgentEvalSuiteCatalogServiceListOptions = {},
  ): Promise<AgentEvalSuiteCatalogServiceListResult> {
    const catalog = await loadAgentEvalSuiteCatalog(mergeLoadOptions(this.defaults, options));
    const suiteIds = options.suiteIds === undefined ? undefined : new Set(options.suiteIds);
    const sourceKinds =
      options.sourceKinds === undefined ? undefined : new Set<AgentEvalSuiteCatalogServiceSourceKind>(options.sourceKinds);
    const environments =
      options.environments === undefined
        ? undefined
        : new Set<NonNullable<AgentEvalSuite['environment']>>(options.environments);

    const entries = catalog.entries
      .filter((entry) => suiteIds === undefined || suiteIds.has(entry.suiteId))
      .filter((entry) => sourceKinds === undefined || sourceKinds.has(entry.source.kind))
      .filter((entry) => environments === undefined || (entry.environment !== undefined && environments.has(entry.environment)))
      .map((entry) =>
        toServiceEntry(entry, {
          includeManifest: options.includeManifest === true,
          includeSuite: options.includeSuite === true,
        }),
      );

    return {
      totalCount: entries.length,
      entries,
    };
  }

  async get(options: AgentEvalSuiteCatalogServiceGetOptions): Promise<AgentEvalSuiteCatalogServiceEntry | undefined> {
    const result = await this.list({
      ...options,
      suiteIds: [options.suiteId],
    });
    return result.entries[0];
  }
}

function toServiceEntry(
  entry: Awaited<ReturnType<typeof loadAgentEvalSuiteCatalog>>['entries'][number],
  options: { includeManifest: boolean; includeSuite: boolean },
): AgentEvalSuiteCatalogServiceEntry {
  const requiredToolNames = new Set<string>();
  const declaredToolNames = new Set<string>();
  const allowedToolNames = new Set<string>();
  const runModes = new Set<string>();
  const caseIds: string[] = [];
  let readonlyOnly = entry.suite.cases.length > 0;

  for (const suiteCase of entry.suite.cases) {
    const evaluationCase = suiteCase.case;
    caseIds.push(evaluationCase.id);
    for (const toolName of evaluationCase.requiredToolCalls ?? []) {
      requiredToolNames.add(toolName);
      declaredToolNames.add(toolName);
    }
    for (const toolName of evaluationCase.forbiddenToolCalls ?? []) {
      declaredToolNames.add(toolName);
    }
    for (const expectation of evaluationCase.requiredToolStatuses ?? []) {
      requiredToolNames.add(expectation.toolName);
      declaredToolNames.add(expectation.toolName);
    }
    for (const expectation of evaluationCase.toolExpectations ?? []) {
      declaredToolNames.add(expectation.toolName);
    }
    for (const toolName of suiteCase.run?.allowedTools ?? []) {
      allowedToolNames.add(toolName);
      declaredToolNames.add(toolName);
    }
    if (suiteCase.run?.mode !== undefined) {
      runModes.add(suiteCase.run.mode);
    }
    readonlyOnly = readonlyOnly && suiteCase.run?.mode === 'readonly';
  }

  return {
    suiteId: entry.suiteId,
    suiteName: entry.suiteName,
    ...(entry.environment === undefined ? {} : { environment: entry.environment }),
    source: cloneJson(entry.source),
    sourceLabel: sourceLabel(entry.source),
    caseCount: entry.suite.cases.length,
    caseIds,
    notes: [...(entry.suite.notes ?? [])],
    declaredToolNames: sorted(declaredToolNames),
    requiredToolNames: sorted(requiredToolNames),
    allowedToolNames: sorted(allowedToolNames),
    runModes: sorted(runModes),
    readonlyOnly,
    ...(options.includeManifest ? { manifest: cloneJson(entry.manifest) } : {}),
    ...(options.includeSuite ? { suite: cloneJson(entry.suite) } : {}),
  };
}

function mergeLoadOptions(
  defaults: AgentEvalSuiteCatalogLoadOptions,
  options: AgentEvalSuiteCatalogServiceListOptions,
): AgentEvalSuiteCatalogLoadOptions {
  return {
    ...(defaults.officialRegistry === undefined ? {} : { officialRegistry: defaults.officialRegistry }),
    ...(defaults.official === undefined ? {} : { official: defaults.official }),
    ...(defaults.workspace === undefined ? {} : { workspace: defaults.workspace }),
    ...(options.officialRegistry === undefined ? {} : { officialRegistry: options.officialRegistry }),
    ...(options.official === undefined ? {} : { official: options.official }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
}

function sourceLabel(source: AgentEvalSuiteCatalogSource): string {
  return source.kind === 'official' ? `official:${source.pluginId}` : `workspace:${source.relativePath}`;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
