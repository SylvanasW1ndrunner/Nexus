import type { AgentEvalSuiteManifest } from './agent-eval-suite-manifest.js';
import type { AgentEvalSuite } from './agent-eval-suite-runner.js';
import { createDefaultOfficialPluginRegistry } from './official-plugin-registry.js';
import type {
  OfficialPluginRegistry,
  OfficialPluginEvalSuiteResolutionOptions,
} from './official-plugin-registry.js';
import {
  loadWorkspaceAgentEvalSuiteManifests,
  type WorkspaceAgentEvalSuiteLoadOptions,
} from './agent-eval-suite-workspace-loader.js';

export type AgentEvalSuiteCatalogSource =
  | {
      kind: 'official';
      pluginId: string;
    }
  | {
      kind: 'workspace';
      relativePath: string;
    };

export type AgentEvalSuiteCatalogEntry = {
  suiteId: string;
  suiteName: string;
  environment?: AgentEvalSuite['environment'];
  source: AgentEvalSuiteCatalogSource;
  manifest: AgentEvalSuiteManifest;
  suite: AgentEvalSuite;
};

export type AgentEvalSuiteCatalogLoadOptions = {
  officialRegistry?: OfficialPluginRegistry;
  official?: OfficialPluginEvalSuiteResolutionOptions | false;
  workspace?: WorkspaceAgentEvalSuiteLoadOptions | false;
};

export type AgentEvalSuiteCatalog = {
  entries: AgentEvalSuiteCatalogEntry[];
};

export async function loadAgentEvalSuiteCatalog(
  options: AgentEvalSuiteCatalogLoadOptions = {},
): Promise<AgentEvalSuiteCatalog> {
  const entries: AgentEvalSuiteCatalogEntry[] = [];

  if (options.official !== false) {
    const registry = options.officialRegistry ?? createDefaultOfficialPluginRegistry();
    const official = registry.resolveEvalSuites(options.official ?? {});
    official.suites.forEach((suite, index) => {
      const manifest = official.manifests[index];
      if (manifest === undefined) {
        throw new Error(`Official eval suite manifest is missing for suite: ${suite.suiteId}`);
      }
      entries.push(
        catalogEntry({
          suite,
          manifest: manifest.manifest,
          source: { kind: 'official', pluginId: manifest.pluginId },
        }),
      );
    });
  }

  if (options.workspace !== undefined && options.workspace !== false) {
    const workspaceSources = await loadWorkspaceAgentEvalSuiteManifests(options.workspace);
    for (const source of workspaceSources) {
      entries.push(
        catalogEntry({
          suite: source.suite,
          manifest: source.manifest,
          source: { kind: 'workspace', relativePath: source.relativePath },
        }),
      );
    }
  }

  assertUniqueCatalogSuiteIds(entries);
  return {
    entries: entries.sort((left, right) => {
      const sourceOrder = sourceSortKey(left.source).localeCompare(sourceSortKey(right.source));
      return sourceOrder === 0 ? left.suiteId.localeCompare(right.suiteId) : sourceOrder;
    }),
  };
}

function catalogEntry(input: {
  suite: AgentEvalSuite;
  manifest: AgentEvalSuiteManifest;
  source: AgentEvalSuiteCatalogSource;
}): AgentEvalSuiteCatalogEntry {
  return {
    suiteId: input.suite.suiteId,
    suiteName: input.suite.suiteName,
    ...(input.suite.environment === undefined ? {} : { environment: input.suite.environment }),
    source: input.source,
    manifest: cloneJson(input.manifest),
    suite: cloneJson(input.suite),
  };
}

function assertUniqueCatalogSuiteIds(entries: AgentEvalSuiteCatalogEntry[]): void {
  const seen = new Map<string, AgentEvalSuiteCatalogSource>();
  for (const entry of entries) {
    const existing = seen.get(entry.suiteId);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate eval suite id ${entry.suiteId}: ${sourceLabel(existing)} and ${sourceLabel(entry.source)}`,
      );
    }
    seen.set(entry.suiteId, entry.source);
  }
}

function sourceSortKey(source: AgentEvalSuiteCatalogSource): string {
  return source.kind === 'official' ? `0:${source.pluginId}` : `1:${source.relativePath}`;
}

function sourceLabel(source: AgentEvalSuiteCatalogSource): string {
  return source.kind === 'official' ? `official plugin ${source.pluginId}` : `workspace ${source.relativePath}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
