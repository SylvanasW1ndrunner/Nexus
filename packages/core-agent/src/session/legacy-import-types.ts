import type { LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type {
  AgentArtifactReference,
  AgentCapabilityStateReference,
  AgentMode,
  AgentTaskPlan,
  AgentToolActivation,
} from '../types.js';

/** Internal-only shapes used to migrate pre-Journal state. Never exported from the package root. */
export type LegacyAgentMessage =
  | { role: 'user'; content: string; createdAt: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; createdAt: string }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; createdAt: string }
  | { role: 'system'; content: string; createdAt: string };

export type LegacyAgentSessionModelBinding = {
  connectionId: string;
  modelId: string;
  routeRevision: string;
  parameters?: Record<string, unknown>;
};

export type LegacyAgentContextCheckpoint = {
  version: 1;
  sequence: number;
  trigger: 'auto' | 'manual';
  method: 'model' | 'deterministic-fallback';
  summary: string;
  coveredConversationMessageCount: number;
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  modelContextTokens: number | null;
  createdAt: string;
  focus?: string;
};

export type LegacyAgentSession = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  messages: LegacyAgentMessage[];
  tokenUsage: LlmUsage;
  modelBinding?: LegacyAgentSessionModelBinding;
  project?: { rootPath: string; configDirectory: string };
  taskPlan?: AgentTaskPlan;
  artifacts?: AgentArtifactReference[];
  toolActivations?: AgentToolActivation[];
  activeSkills?: Array<{ name: string; scope: 'system' | 'user' | 'project' | 'session' }>;
  sessionSkills?: Array<{ content: string; sourcePath?: string }>;
  subagentDepth?: number;
  capabilityStates?: AgentCapabilityStateReference[];
  contextCheckpoint?: LegacyAgentContextCheckpoint;
  aborted: boolean;
};

export type LegacyAgentRunRecordStatus =
  | 'running' | 'done' | 'aborted' | 'failed' | 'interrupted' | 'max_iterations_reached';

export type LegacyAgentRunRecord = {
  runId: string;
  sessionId: string;
  status: LegacyAgentRunRecordStatus;
  phase: 'act' | 'verify' | 'finalize' | 'done';
  iteration: number;
  finalText: string;
  toolExecutions: Array<Record<string, unknown>>;
  completion?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type LegacyAgentUserPreference = {
  id: string;
  userId: string;
  key: string;
  value: string;
  confidence: number;
  sourceSessionId?: string;
  evidence?: string;
  createdAt: string;
  updatedAt: string;
};

export type LegacyAgentSubagentRecord = {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  task: string;
  contextStrategy: 'fresh' | 'fork';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  depth: number;
  summary?: string;
  artifactReferences?: string[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
