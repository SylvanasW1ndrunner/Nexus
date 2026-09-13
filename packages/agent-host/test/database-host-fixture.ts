import { AgentRuntime } from '../src/agent-runtime.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import type { AgentRuntimeOptions } from '../src/types.js';
import {
  DatabaseCapabilityModule,
  DATABASE_CAPABILITY_INSTANCE_ID,
  DATABASE_CAPABILITY_MODULE_ID,
  validateDatabaseCapabilityOptions,
  type DatabaseCapabilityHostPort,
  type DatabaseCapabilityOptions,
} from '@dbagent/database-capability';

/**
 * Test-only product assembly. Production hosts inject a normal Capability
 * registration through AgentRuntimeOptions.modules; the bundled Host has no
 * database-specific composition path.
 */
export function createDatabaseTestHost(
  options: AgentRuntimeOptions & DatabaseCapabilityOptions = {},
) {
  validateDatabaseCapabilityOptions(options);
  const agent = new AgentRuntime(options);
  const services = requireAgentRuntimeHostServices(agent);
  const database = new DatabaseCapabilityModule({
    project: services.project,
    chat: (request, callOptions) => agent.llmChat(request, callOptions),
    embed: (input) => services.embed({
      selection: input.selection,
      input: [...input.input],
      ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
      context: input.context,
    }),
    rerank: (input) => services.rerank({
      selection: input.selection,
      query: input.query,
      documents: [...input.documents],
      ...(input.topN === undefined ? {} : { topN: input.topN }),
      context: input.context,
    }),
    requestCapabilityRefresh: async () => {
      await agent.refreshModule(DATABASE_CAPABILITY_MODULE_ID, DATABASE_CAPABILITY_INSTANCE_ID, {
        deferRetirement: true,
      });
    },
  } satisfies DatabaseCapabilityHostPort, options);
  agent.registerModule(database.registration);
  return { agent, database, close: () => agent.close() };
}
