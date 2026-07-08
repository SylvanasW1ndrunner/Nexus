import type { AgentBehaviorEvaluationReportInput, AgentRunOptions } from '@dbagent/core-agent';
import {
  AgentEvalSuiteCatalogService,
  type AgentEvalSuiteCatalogServiceEntry,
  type AgentEvalSuiteCatalogServiceListOptions,
} from './agent-eval-suite-catalog-service.js';
import {
  runAgentBehaviorEvaluationSuite,
  type AgentEvalSuiteAgent,
  type AgentEvalSuiteRunResult,
} from './agent-eval-suite-runner.js';
import type { AgentEvalSuiteCatalogSource } from './agent-eval-suite-catalog.js';
import {
  evaluateAgentEvalGate,
  type AgentEvalGateDecision,
  type AgentEvalGatePolicy,
} from './agent-eval-gate.js';

export type AgentEvalSuiteRunServiceOptions = {
  agent: AgentEvalSuiteAgent;
  suiteId: string;
  baseRun: Omit<AgentRunOptions, 'userMessage'>;
  catalog?: Omit<AgentEvalSuiteCatalogServiceListOptions, 'suiteIds' | 'includeSuite'>;
  reportId?: string;
  generatedAt?: string;
  reportStorePath?: string;
  stopOnFirstFailure?: boolean;
  reportRun?: AgentBehaviorEvaluationReportInput['run'];
  allowPostgresSuites?: boolean;
  allowLiveSuites?: boolean;
  gate?: AgentEvalGatePolicy;
  failOnGateFailure?: boolean;
};

export type AgentEvalSuiteRunServiceResult = AgentEvalSuiteRunResult & {
  catalogEntry: AgentEvalSuiteCatalogServiceEntry;
  suiteSource: NonNullable<AgentBehaviorEvaluationReportInput['suiteSource']>;
  gate?: AgentEvalGateDecision;
};

export class AgentEvalSuiteRunService {
  constructor(private readonly catalogService = new AgentEvalSuiteCatalogService()) {}

  async run(options: AgentEvalSuiteRunServiceOptions): Promise<AgentEvalSuiteRunServiceResult> {
    const catalogEntry = await this.catalogService.get({
      ...(options.catalog ?? {}),
      suiteId: options.suiteId,
      includeSuite: true,
    });
    if (catalogEntry?.suite === undefined) {
      throw new Error(`Agent eval suite is not available: ${options.suiteId}.`);
    }

    assertRealDependencyGate(catalogEntry, options);
    const suiteSource = toReportSuiteSource(catalogEntry.source);
    const output = await runAgentBehaviorEvaluationSuite({
      agent: options.agent,
      suite: catalogEntry.suite,
      baseRun: options.baseRun,
      suiteSource,
      ...(options.reportId === undefined ? {} : { reportId: options.reportId }),
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
      ...(options.reportStorePath === undefined ? {} : { reportStorePath: options.reportStorePath }),
      ...(options.stopOnFirstFailure === undefined ? {} : { stopOnFirstFailure: options.stopOnFirstFailure }),
      ...(options.reportRun === undefined ? {} : { reportRun: options.reportRun }),
    });

    const result: AgentEvalSuiteRunServiceResult = {
      ...output,
      catalogEntry,
      suiteSource,
    };
    if (options.gate !== undefined) {
      const gate = evaluateAgentEvalGate({
        runResult: output,
        catalogEntry,
        suiteSource,
        policy: options.gate,
        effectiveReadonlyOnly: isEffectiveReadonlySuite(catalogEntry, options.baseRun.mode),
      });
      if (options.failOnGateFailure === true && !gate.passed) {
        throw new AgentEvalSuiteGateError(gate);
      }
      result.gate = gate;
    }
    return result;
  }
}

export class AgentEvalSuiteGateError extends Error {
  constructor(readonly gate: AgentEvalGateDecision) {
    super(`Agent eval gate failed: ${gate.failures.join(' ')}`);
    this.name = 'AgentEvalSuiteGateError';
  }
}

function isEffectiveReadonlySuite(
  catalogEntry: AgentEvalSuiteCatalogServiceEntry,
  baseMode: AgentEvalSuiteRunServiceOptions['baseRun']['mode'],
): boolean {
  if (catalogEntry.readonlyOnly) return true;
  if (baseMode !== 'readonly') return false;
  return catalogEntry.runModes.every((mode) => mode === 'readonly');
}

function assertRealDependencyGate(
  entry: AgentEvalSuiteCatalogServiceEntry,
  options: Pick<AgentEvalSuiteRunServiceOptions, 'allowPostgresSuites' | 'allowLiveSuites'>,
): void {
  if (entry.environment === 'postgres' && options.allowPostgresSuites !== true) {
    throw new Error(
      `Agent eval suite ${entry.suiteId} requires PostgreSQL; pass allowPostgresSuites=true to run it.`,
    );
  }
  if (entry.environment === 'llm-live' && options.allowLiveSuites !== true) {
    throw new Error(
      `Agent eval suite ${entry.suiteId} requires a live LLM provider; pass allowLiveSuites=true to run it.`,
    );
  }
}

function toReportSuiteSource(
  source: AgentEvalSuiteCatalogSource,
): NonNullable<AgentBehaviorEvaluationReportInput['suiteSource']> {
  return source.kind === 'official'
    ? { kind: 'official', pluginId: source.pluginId }
    : { kind: 'workspace', relativePath: source.relativePath };
}
