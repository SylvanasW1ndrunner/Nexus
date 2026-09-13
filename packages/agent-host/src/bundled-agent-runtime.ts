import { AgentRuntime } from './agent-runtime.js';
import {
  CdpBrowserSessionConnector,
  createBrowserCapability,
  createContainerCapability,
  createDataNotebookCapability,
  createDocumentCapability,
  createForgeCapability,
  createGitCapability,
  createLanguageCapability,
  type FirstPartyCapabilityHost,
  type BrowserSessionPort,
} from '@dbagent/first-party-capabilities';
import {
  DatabaseCapabilityModule,
  DATABASE_CAPABILITY_INSTANCE_ID,
  DATABASE_CAPABILITY_MODULE_ID,
  createEnvironmentConnectionProvider,
  type DatabaseCapabilityHostPort,
  type DatabaseCapabilityOptions,
} from '@dbagent/database-capability';
import { requireAgentRuntimeHostServices } from './internal/agent-runtime-host-services.js';
import type { AgentRuntimeOptions } from './types.js';

/**
 * Product composition: registration is metadata-only and external state is
 * probed lazily after a Tool search asks to activate a Capability.
 */
/** Host composition seam for tests and embedders; never persisted as configuration. */
export type BundledAgentRuntimeHostOverrides = Readonly<{
  command?: FirstPartyCapabilityHost['command'];
  executables?: FirstPartyCapabilityHost['executables'];
  browser?: BrowserSessionPort;
  database?: DatabaseCapabilityOptions;
}>;

export type BundledAgentRuntimeOptions = AgentRuntimeOptions;

export function createBundledAgentRuntime(
  options: BundledAgentRuntimeOptions = {},
  hostOverrides: BundledAgentRuntimeHostOverrides = {},
): AgentRuntime {
  const agent = new AgentRuntime(options);
  const services = requireAgentRuntimeHostServices(agent);
  const firstPartyHost: FirstPartyCapabilityHost = Object.freeze({
    workspaceRoot: services.project.rootPath,
    command: hostOverrides.command ?? services.command,
    executables: hostOverrides.executables ?? services.executables,
  });
  const browser = hostOverrides.browser ?? new CdpBrowserSessionConnector({ endpoint: 'http://127.0.0.1:9222' });
  const database = new DatabaseCapabilityModule({
    project: services.project,
    chat: (request, callOptions) => agent.llmChat(request, callOptions),
    embed: input => services.embed({ selection: input.selection, input: [...input.input], ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }), context: input.context }),
    rerank: input => services.rerank({ selection: input.selection, query: input.query, documents: [...input.documents], ...(input.topN === undefined ? {} : { topN: input.topN }), context: input.context }),
    requestCapabilityRefresh: async () => agent.refreshModule(DATABASE_CAPABILITY_MODULE_ID, DATABASE_CAPABILITY_INSTANCE_ID, { deferRetirement: true }),
  } satisfies DatabaseCapabilityHostPort, {
    connectionProvider: createEnvironmentConnectionProvider(),
    ...hostOverrides.database,
  });
  for (const registration of [
    createGitCapability(firstPartyHost),
    database.registration,
    createForgeCapability(firstPartyHost),
    createContainerCapability(firstPartyHost),
    createBrowserCapability({ ...firstPartyHost, browser }),
    createLanguageCapability(firstPartyHost),
    createDocumentCapability(firstPartyHost),
    createDataNotebookCapability(firstPartyHost),
  ]) agent.registerModule(registration);
  return agent;
}
