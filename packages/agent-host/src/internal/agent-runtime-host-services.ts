import type { LlmConnectionManager } from '@dbagent/core-llm';
import type { CapabilityCommandRuntime, PathExecutableDiscovery } from '@dbagent/core-tools';
import type { AgentRuntime } from '../agent-runtime.js';

export type AgentRuntimeHostServices = Readonly<{
  project: Readonly<{ rootPath: string; configDirectory: string; projectId: string; tenantId: string }>;
  embed(input: Parameters<LlmConnectionManager['embed']>[0]): ReturnType<LlmConnectionManager['embed']>;
  rerank(input: Parameters<LlmConnectionManager['rerank']>[0]): ReturnType<LlmConnectionManager['rerank']>;
  command: CapabilityCommandRuntime;
  executables: PathExecutableDiscovery;
}>;

const servicesByRuntime = new WeakMap<AgentRuntime, AgentRuntimeHostServices>();

export function registerAgentRuntimeHostServices(
  runtime: AgentRuntime,
  services: AgentRuntimeHostServices,
): void {
  servicesByRuntime.set(runtime, Object.freeze(services));
}

export function requireAgentRuntimeHostServices(runtime: AgentRuntime): AgentRuntimeHostServices {
  const services = servicesByRuntime.get(runtime);
  if (!services) throw new Error('AgentRuntime host services are unavailable.');
  return services;
}
